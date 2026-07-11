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
    writeProfile, writeClientFromComment, flushProfileRows,
} from './src/sheets.js';
import { isIndonesian } from './src/classifier.js';
import { MAX_API_ERRORS_CONSECUTIVE, REQUEST_DELAY } from './src/config.js';
import {
    loadState, forceSave, checkpoint,
    getState, setCurrentHashtag, setPhase,
    addToQueue, getNextInQueue, markQueueDone,
    isVisited, markVisited, markEnriched, getQueueStats,
    addHashtag, getHashtags,
    incStats,
    printStats,
} from './src/state.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const MAX_DEPTH = 4;
const POSTS_PER_PROFILE = 20;

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

    // Build available list from sheet
    const doneInState = new Set(
        Object.entries(state.hashtags)
            .filter(([, v]) => v.status === 'Executed')
            .map(([k]) => k)
    );

    let availableHashtags = pendingHashtags.filter(h => {
        const clean = h.replace(/^#/, '').toLowerCase().trim();
        return !doneInState.has(clean);
    });

    // If no available hashtags from sheet, try fallback to state.json hashtags
    if (availableHashtags.length === 0) {
        const stateHashtags = Object.keys(state.hashtags);
        if (stateHashtags.length > 0) {
            // Use state.json hashtags that are NOT Executed
            const statePending = stateHashtags.filter(tag => {
                const s = state.hashtags[tag];
                return s.status !== 'Executed';
            });
            availableHashtags = statePending.map(t => '#' + t);
            console.log(`[STATE] Loaded ${availableHashtags.length} hashtags from state file (fallback)`);
        }
    }

    // If still no available hashtags: check if sheet has any at all
    if (availableHashtags.length === 0) {
        const allHashtagsRaw = await readHashtagsWithStatus();
        const allTags = allHashtagsRaw.map(r => r.tag);

        if (allTags.length > 0) {
            // Sheet has hashtags but all Executed → reset to Pending
            console.log('[INFO] All hashtags executed — resetting sheet statuses to Pending...');
            await resetHashtagStatuses();
            const reloaded = await readHashtags();
            availableHashtags = reloaded;
            console.log('[INFO] Reset complete — processing hashtags.');
        }

        // If still nothing, check state.json — if all Executed, clear and start fresh
        if (availableHashtags.length === 0) {
            const stateHashtags = Object.entries(state.hashtags);
            const allExecuted = stateHashtags.length > 0 && stateHashtags.every(([, v]) => v.status === 'Executed');
            if (allExecuted) {
                console.log('[INFO] All state hashtags executed — clearing state and starting fresh...');
                const { loadState: reloadState } = await import('./src/state.js');
                // Reset all hashtag statuses in state
                const fs = await import('fs');
                const statePath = './discovery-state.json';
                const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                for (const tag of Object.keys(raw.hashtags)) {
                    raw.hashtags[tag].status = 'Pending';
                }
                fs.writeFileSync(statePath, JSON.stringify(raw, null, 2));
                await reloadState();
                const fresh = Object.keys(getState().hashtags).filter(t => getState().hashtags[t].status !== 'Executed');
                availableHashtags = fresh.map(t => '#' + t);
                console.log(`[INFO] State reset — ${availableHashtags.length} hashtags ready.`);
            } else {
                console.log('[ERROR] No pending hashtags found anywhere. Add hashtags with status=Pending to sheet, or clear state.');
                process.exit(1);
            }
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
                // Outer retry loop: 3x with normal delay, then 3x with longer delay, repeat until AI is up
                let aiHashtags = [];
                let retryRound = 0;
                const MAX_INNER_RETRIES = 3;
                while (aiHashtags.length === 0 && retryRound < 10) {
                    try {
                        aiHashtags = await classifyHashtagsBatch(tagsToClassify);
                    } catch (e) {
                        retryRound++;
                        if (retryRound < MAX_INNER_RETRIES) {
                            const delay = 5000 * Math.pow(2, retryRound - 1);
                            console.log(`  [AI] Classification failed: ${e.message} — retry ${retryRound}/${MAX_INNER_RETRIES} in ${delay / 1000}s...`);
                            await sleep(delay);
                        } else if (retryRound < MAX_INNER_RETRIES * 2) {
                            const delay = 30000 + 10000 * (retryRound - MAX_INNER_RETRIES);
                            console.log(`  [AI] Still failing after ${MAX_INNER_RETRIES} retries — extended wait ${delay / 1000}s...`);
                            await sleep(delay);
                        } else {
                            // Reset round counter for next cycle
                            retryRound = 0;
                            const delay = 60000;
                            console.log(`  [AI] Still failing — waiting 60s before next cycle...`);
                            await sleep(delay);
                        }
                    }
                }
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
    await flushProfileRows();
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

    // Write directly to sheets (sheets.js handles batching/flush)
    await writeProfile(profile, existingUsernames);
    sessionProfileCount++;
    incStats('profiles');

    if (sessionProfileCount % 10 === 0) {
        await forceSave();
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
    await flushProfileRows();
}

// ===== SIGNALS =====
process.on('SIGINT', async () => {
    console.log('\n[ABORT] Saving state before exit...');
    await flushProfileRows();
    await forceSave();
    printStats();
    await closeBrowser().catch(() => {});
    process.exit(1);
});

process.on('uncaughtException', async (e) => {
    console.error('[CRASH]', e.message);
    await flushProfileRows().catch(() => {});
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
