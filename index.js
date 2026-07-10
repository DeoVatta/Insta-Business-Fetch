/**
 * Instagram Prospector — Persistence + Nested Depth 4
 *
 * Single script, 24/7 non-stop, auto-resume on crash.
 *
 * Flow:
 * 1. Load state → resume if exists
 * 2. Pick pending hashtag
 * 3. Scrape hashtag → get posts
 * 4. Per post: enrich → collect hashtags/mentions/collabs
 * 5. Per new profile:
 *    a. Enrich profile
 *    b. Enrich 20 recent posts (FULL enrichment)
 *    c. Collect hashtags + mentions + collabs from 20 posts
 *    d. Add new profiles to queue (depth+1)
 * 6. Process discovery queue (depth 2, 3, 4)
 * 7. Save state every 10 profiles
 * 8. Repeat until queue empty → next hashtag
 */

import {
    initBrowser, closeBrowser, refreshCookieStr,
    enrichPost, scrapeHashtag, fetchAllPostCommentsGraphQL,
} from './src/scraper.js';
import { enrichProfile } from './src/enricher.js';
import { filterClients } from './src/comments.js';
import { classifyProfilesBatch, classifyHashtagsBatch } from './src/ai-classifier.js';
import {
    initSheets, readHashtags, readHashtagsWithStatus, readHashtagsInSheet, readVisitedProfiles,
    writeHashtagBatch, markHashtagStatus, resetHashtagStatuses,
    writeProfile, writeClientFromComment,
} from './src/sheets.js';
import { isIndonesian } from './src/classifier.js';
import { MAX_API_ERRORS_CONSECUTIVE, REQUEST_DELAY } from './src/config.js';
import {
    loadState, forceSave, checkpoint,
    getState, setCurrentHashtag, setPhase,
    addToQueue, getNextInQueue, markQueueDone,
    isVisited, markVisited, markEnriched, getQueueStats,
    addHashtag, getHashtags,
    incStats, bufferProfile, getProfileBuffer, clearProfileBuffer,
    printStats, clearState,
} from './src/state.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const MAX_DEPTH = 4;
const PROFILE_BATCH_SIZE = 10;
const POSTS_PER_PROFILE = 20;
const SAVE_EVERY = 10;

let postCount = 0;
let globalErrorCount = 0;
let sessionProfileCount = 0;

async function run() {
    console.log('='.repeat(60));
    console.log('INSTAGRAM PROSPECTOR — Persistence + Nested Depth 4');
    console.log('='.repeat(60));

    // INIT
    await initSheets();
    await initBrowser();
    await refreshCookieStr();

    // LOAD OR CREATE STATE
    const state = await loadState();
    const existingUsernames = new Set(Object.keys(state.visited));
    const existingHashtags = new Set(
        Object.keys(state.hashtags)
    );

    // Get pending hashtags from sheet
    const pendingHashtags = await readHashtags();

    // Check which hashtags are already done in state
    const doneInState = new Set(
        Object.entries(state.hashtags)
            .filter(([, v]) => v.status === 'Executed')
            .map(([k]) => k)
    );
    let availableHashtags = pendingHashtags.filter(h => {
        const clean = h.replace(/^#/, '').toLowerCase().trim();
        return !doneInState.has(clean);
    });

    // If no available hashtags: check if sheet has any hashtags at all
    if (availableHashtags.length === 0) {
        // Read all hashtags (including Executed) to check status
        const allHashtagsRaw = await readHashtagsWithStatus();
        const allTags = allHashtagsRaw.map(r => r.tag);

        if (allTags.length > 0) {
            // Sheet has hashtags but all Executed → reset to Pending
            console.log('[INFO] All hashtags executed — resetting sheet statuses to Pending...');
            await resetHashtagStatuses();
            // Reload pending
            const reloaded = await readHashtags();
            availableHashtags = reloaded;
            await clearState();
            console.log('[INFO] Reset complete — fresh scan starting.');
        }

        if (availableHashtags.length === 0) {
            console.log('[ERROR] No pending hashtags in Hashtags sheet. Add hashtags with status=Pending.');
            process.exit(1);
        }
    }

    console.log(`[RUN] ${availableHashtags.length} available hashtags to process`);
    console.log(`[RUN] Queue: ${getQueueStats().pending} pending, Depth max: ${MAX_DEPTH}`);

    // MAIN LOOP: Process hashtags until all done
    let hashtagIdx = 0;
    while (hashtagIdx < availableHashtags.length) {
        const hashtag = availableHashtags[hashtagIdx];
        setCurrentHashtag(hashtag, 'Executing');
        await markHashtagStatus(hashtag, 'Executing');
        await refreshCookieStr();
        await checkpoint(`Start hashtag ${hashtag}`);

        console.log('\n' + '='.repeat(60));
        console.log(`[HASHTAG ${hashtagIdx + 1}/${availableHashtags.length}] ${hashtag}`);
        console.log('='.repeat(60));

        // PHASE 1: Scrape hashtag
        console.log('\n[PHASE 1] Scraping hashtag...');
        setPhase('hashtag-scrape');
        const posts = await scrapeHashtag(hashtag);
        console.log(`  → ${posts.length} posts found`);

        if (posts.length === 0) {
            await markHashtagStatus(hashtag, 'Executed');
            hashtagIdx++;
            continue;
        }

        // PHASE 2: Process hashtag posts → collect profiles
        console.log('\n[PHASE 2] Processing hashtag posts...');
        setPhase('post-enrich');
        postCount = 0;
        globalErrorCount = 0;

        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];

            if (postCount > 0 && postCount % 20 === 0) {
                console.log(`\n[REAUTH] Refreshing cookies (post ${postCount})...`);
                await refreshCookieStr();
            }

            const postNum = i + 1;
            const shortcode = post.shortcode || '';
            const postUrl = `https://www.instagram.com/p/${shortcode}/`;
            console.log(`\n[POST ${postNum}/${posts.length}] ${shortcode}`);

            setPhase('post-enrich', { shortcode, index: i });

            const postData = await enrichPost(postUrl);
            if (!postData || !postData.username) { globalErrorCount++; continue; }

            const username = postData.username.toLowerCase();
            if (username === 'deovatta' || !username) continue;

            // Collect hashtags from post
            for (const tag of (postData.hashtags || [])) {
                const clean = tag.replace(/^#/, '').toLowerCase().trim();
                if (!clean) continue;
                addHashtag('#' + clean, `post:${shortcode}`);
            }

            // Indonesian check via caption
            const postText = ((postData.caption || '') + ' ' + (postData.hashtags || []).join(' ')).toLowerCase();
            if (!isIndonesian(postText, [], '')) {
                console.log(`  [SKIP] @${username} — not Indonesian`); continue;
            }

            // Enrich profile
            const profile = await enrichProfile(username, postData);
            if (!profile) { globalErrorCount++; continue; }
            globalErrorCount = 0;

            // Profile Indonesian check
            if (!isIndonesian(profile.bio || '', [...(profile.hashtags || [])], profile.nativeLocation || '')) {
                console.log(`  [SKIP] @${username} — profile not Indonesian`); continue;
            }

            // Mark as visited (depth 1)
            const visitedInfo = markVisited(username, 1);
            if (visitedInfo.depth === 1 && !visitedInfo.enriched) {
                // First time seeing this profile → full nested enrichment
                await enrichAndNestedDiscover(username, profile, 1, shortcode, existingUsernames);
            }

            // Collect mentions + collabs from caption → add to queue (depth 2)
            for (const m of [...(postData.mentions || []), ...(postData.collabs || [])]) {
                const mLower = m.toLowerCase();
                addToQueue(mLower, 2, username);
            }

            // PHASE 5: Comment extraction for last 10 posts
            const allComments = await fetchAllPostCommentsGraphQL(shortcode, 100);
            if (allComments?.length) {
                const clients = filterClients(allComments, username);
                for (const client of clients) {
                    const cUser = client.username.toLowerCase();
                    if (isVisited(cUser)) continue;
                    const clientData = {
                        username: cUser,
                        via: 'comment',
                        source: hashtag,
                        commentText: (client.text || '').slice(0, 200),
                        location: '',
                        profileUrl: `https://instagram.com/${cUser}/`,
                    };
                    await writeClientFromComment(clientData, existingUsernames);
                    incStats('clients');
                    markVisited(cUser, 0);
                }
            }

            postCount++;
            await sleep(REQUEST_DELAY * 1000);
        }

        await checkpoint(`Hashtag ${hashtag} posts done`);
        await markHashtagStatus(hashtag, 'Executed');

        // PHASE 3: AI classify all collected hashtags → write business ones to sheet
        console.log('\n[PHASE 3] AI hashtag classification...');
        const allHT = getHashtags();
        if (allHT.length > 0) {
            const tagsToClassify = allHT.filter(h => h.status === 'Pending').map(h => h.tag);
            if (tagsToClassify.length > 0) {
                const aiHashtags = await classifyHashtagsBatch(tagsToClassify);
                if (aiHashtags.length > 0) {
                    const withCounts = aiHashtags.map(h => ({
                        tag: h.tag,
                        found: state.hashtags[h.tag.replace('#', '')]?.found || 1,
                    }));
                    const written = await writeHashtagBatch(withCounts, existingHashtags);
                    incStats('hashtagsWritten', written);
                }
            }
        }

        hashtagIdx++;
        await forceSave();
    }

    // PHASE 4: Process discovery queue (depth 2, 3, 4)
    console.log('\n' + '='.repeat(60));
    console.log('[PHASE 4] Discovery queue — nested depth 2-4...');
    console.log('='.repeat(60));

    await processDiscoveryQueue(existingUsernames);

    // DONE
    await forceSave();
    await checkpoint('All hashtags complete');
    printStats();
    await closeBrowser();

    console.log('\n' + '='.repeat(60));
    console.log('[DONE] All hashtags processed. Discovery queue may still have pending items.');
    console.log('       Run again to continue processing queue.');
    console.log('='.repeat(60));
}

/**
 * Full nested enrichment: enrich 20 recent posts per profile
 * Extract hashtags, mentions, collabs → add to queue
 */
async function enrichAndNestedDiscover(username, profile, depth, sourcePost, existingUsernames) {
    console.log(`\n[NESTED D${depth}] @${username} — enriching ${POSTS_PER_PROFILE} posts...`);
    setPhase('profile-nested', { username, depth });

    const profilePostUrls = profile.profilePostUrls || [];
    const postsToEnrich = profilePostUrls.slice(0, POSTS_PER_PROFILE);

    let discErrors = 0;

    for (let pi = 0; pi < postsToEnrich.length; pi++) {
        const postUrl = postsToEnrich[pi];
        const shortcode = postUrl.split('/p/')[1]?.replace('/', '') || '';

        console.log(`  [POST ${pi + 1}/${postsToEnrich.length}] ${shortcode}`);

        try {
            const postData = await enrichPost(postUrl);
            if (!postData) { discErrors++; continue; }
            discErrors = 0;

            // Collect hashtags
            for (const tag of (postData.hashtags || [])) {
                const clean = tag.replace(/^#/, '').toLowerCase().trim();
                if (!clean) continue;
                addHashtag('#' + clean, `${username}:post:${shortcode}`);
            }

            // Collect mentions + collabs → add to queue (depth+1)
            const allMentions = [...(postData.mentions || []), ...(postData.collabs || [])];
            for (const m of allMentions) {
                const mLower = m.toLowerCase();
                addToQueue(mLower, depth + 1, username);
            }

            // Comment extraction (only for depth 1, skip for depth 2+ to save time)
            if (depth === 1) {
                const allComments = await fetchAllPostCommentsGraphQL(shortcode, 100);
                if (allComments?.length) {
                    const clients = filterClients(allComments, username);
                    for (const client of clients) {
                        const cUser = client.username.toLowerCase();
                        if (isVisited(cUser)) continue;
                        const clientData = {
                            username: cUser,
                            via: 'comment',
                            source: `${username}:${shortcode}`,
                            commentText: (client.text || '').slice(0, 200),
                            location: '',
                            profileUrl: `https://instagram.com/${cUser}/`,
                        };
                        await writeClientFromComment(clientData, existingUsernames);
                        incStats('clients');
                        markVisited(cUser, 0);
                    }
                }
            }

            await sleep(REQUEST_DELAY * 1000);
        } catch (e) {
            discErrors++;
            console.log(`  [ERROR] Post ${shortcode}: ${e.message}`);
        }
    }

    // Mark profile as enriched
    markEnriched(username);

    // Add profile to batch for AI write
    profile.sourceHashtag = `nested d${depth} via @${sourcePost}`;
    profile.via = 'discovery';
    bufferProfile(profile);
    existingUsernames.add(username.toLowerCase());

    sessionProfileCount++;
    incStats('profiles');

    if (sessionProfileCount % SAVE_EVERY === 0) {
        await flushProfileBuffer(existingUsernames);
        await checkpoint(`Saved after ${sessionProfileCount} profiles`);
        printStats();
    }
}

/**
 * Process discovery queue — depth 2, 3, 4
 */
async function processDiscoveryQueue(existingUsernames) {
    let discCount = 0;
    let consecutiveSeen = 0;

    while (true) {
        const item = getNextInQueue(MAX_DEPTH);
        if (!item) {
            console.log('\n[QUEUE] Empty — discovery complete for this hashtag');
            break;
        }

        const { username, depth, source } = item;
        console.log(`\n[QUEUE ${++discCount}] @${username} (depth=${depth}, via=@${source})`);

        if (discCount > 0 && discCount % 20 === 0) {
            console.log(`\n[REAUTH] Refreshing cookies...`);
            await refreshCookieStr();
        }

        // Skip if somehow already visited
        if (isVisited(username)) {
            consecutiveSeen++;
            if (consecutiveSeen >= 10) {
                console.log(`\n[QUEUE] 10 consecutive seen — stopping`);
                break;
            }
            continue;
        }
        consecutiveSeen = 0;

        markVisited(username, depth);
        existingUsernames.add(username.toLowerCase());

        // Enrich profile
        setPhase('profile-enrich', { username, depth });
        const profile = await enrichProfile(username);
        if (!profile) {
            markQueueDone(username);
            continue;
        }

        // Indonesian check
        if (!isIndonesian(profile.bio || '', [...(profile.hashtags || [])], profile.nativeLocation || '')) {
            console.log(`  [SKIP] @${username} — not Indonesian`);
            markQueueDone(username);
            continue;
        }

        // Full nested enrichment: 20 posts per profile
        await enrichAndNestedDiscover(username, profile, depth, source, existingUsernames);

        markQueueDone(username);
    }

    // Flush remaining buffer
    await flushProfileBuffer(existingUsernames);
}

/**
 * Flush profile buffer: AI batch → write to sheet
 */
async function flushProfileBuffer(existingUsernames) {
    const buf = getProfileBuffer();
    if (!buf || buf.length === 0) return;

    console.log(`\n[FLUSH] Processing ${buf.length} buffered profiles...`);

    // Dedupe buffer
    const seen = new Set();
    const unique = buf.filter(p => {
        const key = (p.username || '').toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    if (unique.length === 0) {
        clearProfileBuffer();
        return;
    }

    // AI batch classify
    incStats('batches');
    try {
        const aiProfiles = await classifyProfilesBatch(unique);
        incStats('aiProfiles', aiProfiles.length);

        for (const p of aiProfiles) {
            await writeProfile(p, existingUsernames);
        }

        console.log(`  → ${aiProfiles.length} profiles written to sheet`);
    } catch (e) {
        console.warn(`[FLUSH] AI batch failed: ${e.message} — using fallback`);
        for (const p of unique) {
            await writeProfile(p, existingUsernames);
        }
    }

    clearProfileBuffer();
    await forceSave();
}

// ===== SIGNALS =====
process.on('SIGINT', async () => {
    console.log('\n[ABORT] Saving state before exit...');
    await flushProfileBuffer(new Set());
    await forceSave();
    printStats();
    await closeBrowser().catch(() => {});
    process.exit(1);
});

process.on('uncaughtException', async (e) => {
    console.error('[CRASH]', e.message);
    await flushProfileBuffer(new Set()).catch(() => {});
    await forceSave();
    await closeBrowser().catch(() => {});
    process.exit(1);
});

process.on('unhandledRejection', async (e) => {
    console.error('[REJECT]', e);
    await forceSave();
});

// ===== START =====
run().catch(async (e) => {
    console.error('[FATAL]', e.message);
    await forceSave().catch(() => {});
    await closeBrowser().catch(() => {});
    process.exit(1);
});
