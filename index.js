/**
 * Instagram Prospector - Sequential Pipeline + AI Classification
 *
 * Two sheets:
 * - "Instagram" — profile data
 * - "Hashtags"  — hashtag tracking (only AI-approved business hashtags)
 *
 * Flow:
 * PHASE 1  — Scrape hashtag
 * PHASE 2  — Enrich + collect hashtags
 * PHASE 3  — AI batch hashtag classify → write only business ones to Hashtags sheet
 * PHASE 4  — Enrich profiles → buffer 10 → AI batch → WRITE immediately
 * PHASE 5  — Comment extraction → client discovery
 * PHASE 6  — Discovery queue (AI batch every 10 profiles → WRITE immediately)
 * PHASE 7  — Every 20 posts: re-login
 */

import {
    initBrowser, closeBrowser, refreshCookieStr,
    enrichPost, scrapeHashtag, fetchAllPostCommentsGraphQL,
} from './src/scraper.js';
import { enrichProfile } from './src/enricher.js';
import { filterClients } from './src/comments.js';
import { classifyProfilesBatch, classifyHashtagsBatch } from './src/ai-classifier.js';
import {
    initSheets, readHashtags, readHashtagsInSheet, readVisitedProfiles,
    writeHashtagBatch, markHashtagStatus,
    writeProfile, writeClientFromComment,
} from './src/sheets.js';
import { isIndonesian } from './src/classifier.js';
import { MAX_COLLAB_DEPTH, MAX_API_ERRORS_CONSECUTIVE, PHASE2_TIMEOUT_MIN, REQUEST_DELAY } from './src/config.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PROFILE_BATCH_SIZE = 10;
const DISCOVERY_BATCH_SIZE = 10;

let _currentHashtag = null;

async function run() {
    console.log('='.repeat(60));
    console.log('INSTAGRAM PROSPECTOR — Pipeline + AI (batch 10)');
    console.log('='.repeat(60));

    // INIT
    console.log('\n[INIT] Starting...\n');
    await initSheets();
    await initBrowser();
    await refreshCookieStr();

    const pendingHashtags = await readHashtags();
    if (pendingHashtags.length === 0) {
        console.log('[ERROR] No pending hashtags in Hashtags sheet. Add hashtags with status=Pending.');
        process.exit(1);
    }

    const visited = await readVisitedProfiles();
    const hashtagsInSheet = await readHashtagsInSheet();

    let stats = { profiles: 0, clients: 0, errors: 0, aiProfiles: 0, hashtagsWritten: 0, batches: 0 };
    let globalErrorCount = 0;
    let phase2Start = Date.now();
    let postCount = 0;

    const hashtag = pendingHashtags[0];
    _currentHashtag = hashtag;

    console.log('-'.repeat(60));
    console.log(`[RUN] Hashtag: ${hashtag} | Batch size: ${PROFILE_BATCH_SIZE}`);
    console.log('-'.repeat(60));

    await markHashtagStatus(hashtag, 'Executing');
    await refreshCookieStr();

    // PHASE 1 — Scrape
    console.log('\n[PHASE 1] Scraping hashtag...\n');
    const posts = await scrapeHashtag(hashtag);
    console.log(`\n  → Found ${posts.length} posts\n`);

    if (posts.length === 0) {
        await markHashtagStatus(hashtag, 'Executed');
        await closeBrowser();
        printSummary(stats, hashtag);
        return;
    }

    // PHASE 2 — Enrich + collect hashtags
    console.log('-'.repeat(60));
    console.log('[PHASE 2] Enriching profiles + collecting hashtags...');
    console.log('-'.repeat(60) + '\n');

    const profileBuffer = [];
    const discoveryQueue = [];
    const seenInQueue = new Set();
    const allHashtags = new Set();
    const hashtagCounts = {};

    for (let i = 0; i < posts.length; i++) {
        const post = posts[i];

        if (postCount > 0 && postCount % 20 === 0) {
            console.log(`\n[PHASE 7] Re-login (count=${postCount})...`);
            await refreshCookieStr();
        }
        postCount++;

        const elapsedMin = (Date.now() - phase2Start) / 60000;
        if (elapsedMin >= (PHASE2_TIMEOUT_MIN || 60)) {
            console.log(`\n[STOP] ${elapsedMin.toFixed(1)} min timeout.`); break;
        }

        const postNum = i + 1;
        const shortcode = post.shortcode || '';
        const postUrl = `https://www.instagram.com/p/${shortcode}/`;
        console.log(`\n[POST ${postNum}/${posts.length}] ${shortcode}`);

        const postData = await enrichPost(postUrl);
        if (!postData || !postData.username) { globalErrorCount++; continue; }

        const username = postData.username.toLowerCase();
        if (username === 'deovatta' || !username) { console.log(`  [SKIP] Own account`); continue; }

        const isNewProfile = !visited.has(username);

        // Collect hashtags
        for (const tag of (postData.hashtags || [])) {
            const clean = tag.replace(/^#/, '').toLowerCase().trim();
            if (!clean) continue;
            allHashtags.add('#' + clean);
            hashtagCounts[clean] = (hashtagCounts[clean] || 0) + 1;
        }

        const postText = ((postData.caption || '') + ' ' + (postData.hashtags || []).join(' ')).toLowerCase();
        if (!isIndonesian(postText, [], '')) { console.log(`  [SKIP] @${username} — not Indonesian`); continue; }

        const profile = await enrichProfile(username, postData);
        if (!profile) { globalErrorCount++; continue; }
        globalErrorCount = 0;

        if (!isIndonesian(profile.bio || '', [...(profile.hashtags || [])], profile.nativeLocation || '')) {
            console.log(`  [SKIP] @${username} — profile not Indonesian`); continue;
        }

        profile.sourceHashtag = hashtag;
        profile.via = 'hashtag';

        if (isNewProfile) {
            profileBuffer.push(profile);
            visited.add(username);
            stats.profiles++;

            // Buffer full → AI batch → WRITE immediately
            if (profileBuffer.length >= PROFILE_BATCH_SIZE) {
                stats.batches++;
                console.log(`\n[PHASE 4] AI batch ${stats.batches} — processing ${profileBuffer.length} profiles...`);

                const aiProfiles = await classifyProfilesBatch(profileBuffer);

                for (const p of aiProfiles) {
                    await writeProfile(p, visited);
                    stats.aiProfiles++;
                }

                console.log(`  → ${aiProfiles.length} profiles written to sheet`);
                profileBuffer.length = 0;
            }
        }

        // Discovery
        for (const m of [...(postData.mentions || []), ...(postData.collabs || [])]) {
            const mLower = m.toLowerCase();
            if (!visited.has(mLower) && !seenInQueue.has(mLower)) {
                seenInQueue.add(mLower);
                discoveryQueue.push({ username: mLower, depth: 1, source: username });
            }
        }
    }

    // Flush remaining buffer
    if (profileBuffer.length > 0) {
        stats.batches++;
        console.log(`\n[PHASE 4] Flushing buffer — ${profileBuffer.length} profiles...`);
        const aiProfiles = await classifyProfilesBatch(profileBuffer);
        for (const p of aiProfiles) {
            await writeProfile(p, visited);
            stats.aiProfiles++;
        }
        console.log(`  → ${aiProfiles.length} profiles written`);
        profileBuffer.length = 0;
    }

    // PHASE 3 — AI classify hashtags → write business ones
    console.log('\n' + '-'.repeat(60));
    console.log(`[PHASE 3] AI hashtag classification — ${allHashtags.size} unique hashtags...`);
    console.log('-'.repeat(60) + '\n');

    const hashtagArray = [...allHashtags].map(t => ({ tag: t, found: hashtagCounts[t.replace('#', '')] || 1 }));
    const aiHashtags = await classifyHashtagsBatch(hashtagArray.map(h => h.tag));

    if (aiHashtags.length > 0) {
        const withCounts = aiHashtags.map(h => ({
            tag: h.tag,
            found: hashtagCounts[h.tag.replace('#', '')] || 1,
        }));
        const written = await writeHashtagBatch(withCounts, hashtagsInSheet);
        stats.hashtagsWritten = written;
    } else {
        console.log('[PHASE 3] No business-related hashtags found');
    }

    // PHASE 5 — Comment extraction
    console.log('\n' + '-'.repeat(60));
    console.log(`[PHASE 5] Comment extraction (${posts.slice(-10).length} posts)...`);
    console.log('-'.repeat(60) + '\n');

    for (const post of posts.slice(-10)) {
        const shortcode = post.shortcode || '';
        console.log(`\n[COMMENT] ${shortcode}`);

        const postAuthor = (post.username || '').toLowerCase();
        const allComments = await fetchAllPostCommentsGraphQL(shortcode, 100);
        if (!allComments?.length) { console.log(`  → 0 comments`); continue; }
        console.log(`  → ${allComments.length} comments`);

        const clients = filterClients(allComments, postAuthor || null);
        for (const client of clients) {
            const cUser = client.username.toLowerCase();
            if (visited.has(cUser)) continue;
            const clientData = {
                username: cUser,
                via: 'comment',
                source: hashtag,
                commentText: (client.text || '').slice(0, 200),
                location: '',
                profileUrl: `https://instagram.com/${cUser}/`,
            };
            await writeClientFromComment(clientData, visited);
            stats.clients++;
        }

        await sleep(REQUEST_DELAY * 1000);
    }

    // PHASE 6 — Discovery queue (AI batch every 10 → WRITE immediately)
    console.log('\n' + '-'.repeat(60));
    console.log(`[PHASE 6] Discovery queue (${discoveryQueue.length} profiles)...`);
    console.log('-'.repeat(60) + '\n');

    let discCount = 0, discErrors = 0, consecutiveSeen = 0, discPostCount = 0;
    const discBuffer = [];

    while (discoveryQueue.length > 0) {
        const item = discoveryQueue.shift();
        if (visited.has(item.username)) { consecutiveSeen++; if (consecutiveSeen >= 10) break; continue; }
        if (item.depth > (MAX_COLLAB_DEPTH || 2)) continue;

        visited.add(item.username);
        discCount++;

        if (discPostCount > 0 && discPostCount % 20 === 0) {
            console.log(`\n[PHASE 7] Re-login (discovery=${discCount})...`);
            await refreshCookieStr();
        }
        discPostCount++;

        console.log(`\n[DISCOVER ${discCount}] @${item.username} (via @${item.source}, depth=${item.depth})`);

        const profile = await enrichProfile(item.username);
        if (!profile) { discErrors++; continue; }
        discErrors = 0;

        if (!isIndonesian(profile.bio || '', [...(profile.hashtags || [])], profile.nativeLocation || '')) continue;

        profile.sourceHashtag = `collab via @${item.source}`;
        profile.via = 'discovery';

        discBuffer.push(profile);

        // Buffer full → AI batch → WRITE immediately
        if (discBuffer.length >= DISCOVERY_BATCH_SIZE) {
            console.log(`\n[PHASE 6] Discovery batch — AI + write ${discBuffer.length} profiles...`);
            const aiResults = await classifyProfilesBatch(discBuffer);
            for (const p of aiResults) {
                await writeProfile(p, visited);
                stats.aiProfiles++;
            }
            discBuffer.length = 0;
        }
    }

    // Flush remaining discovery
    if (discBuffer.length > 0) {
        console.log(`\n[PHASE 6] Flushing discovery buffer — ${discBuffer.length} profiles...`);
        const aiResults = await classifyProfilesBatch(discBuffer);
        for (const p of aiResults) {
            await writeProfile(p, visited);
            stats.aiProfiles++;
        }
    }

    await markHashtagStatus(hashtag, 'Executed');
    await closeBrowser();
    printSummary(stats, hashtag);
}

function printSummary(stats, hashtag) {
    console.log('\n' + '='.repeat(60));
    console.log('[DONE] SCAN COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Hashtag:      ${hashtag}`);
    console.log(`  Profiles:     ${stats.profiles}`);
    console.log(`  AI Batches:   ${stats.batches}`);
    console.log(`  AI Processed: ${stats.aiProfiles}`);
    console.log(`  Hashtags:     ${stats.hashtagsWritten} written to Hashtags sheet`);
    console.log(`  Clients:      ${stats.clients}`);
    console.log('='.repeat(60));
}

process.on('SIGINT', async () => {
    console.log('\n[ABORT] Closing...');
    if (_currentHashtag) await markHashtagStatus(_currentHashtag, 'Failed').catch(() => {});
    await closeBrowser().catch(() => {});
    process.exit(1);
});

run().catch(async (e) => {
    console.error('[FATAL]', e.message);
    if (_currentHashtag) await markHashtagStatus(_currentHashtag, 'Failed').catch(() => {});
    await closeBrowser().catch(() => {});
    process.exit(1);
});
