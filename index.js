/**
 * Instagram Prospector - Sequential Pipeline
 *
 * Single "Instagram" sheet for all data.
 * AI batch classification via Olagon Gateway (up to 150 profiles/request).
 *
 * Pipeline:
 * PHASE 1  — Scrape hashtag → get all post data
 * PHASE 2  — Loop posts sequentially
 * PHASE 3  — Indonesian indicator check
 * PHASE 4  — Enrich profile → classify
 * PHASE 5  — Collect up to 150 profiles → AI batch classify
 * PHASE 6  — Write AI-enriched data to Instagram sheet
 * PHASE 7  — Comment extraction → client discovery
 * PHASE 8  — Every 20 posts: re-login
 */

import {
    initBrowser, closeBrowser, refreshCookieStr,
    enrichPost, scrapeHashtag, fetchAllPostCommentsGraphQL,
} from './src/scraper.js';
import { enrichProfile } from './src/enricher.js';
import { filterClients } from './src/comments.js';
import { classifyProfilesBatch } from './src/ai-classifier.js';
import {
    initSheets, readHashtags, readVisitedProfiles,
    writeProfile, writeClientFromComment,
} from './src/sheets.js';
import { isIndonesian } from './src/classifier.js';
import { MAX_COLLAB_DEPTH, MAX_API_ERRORS_CONSECUTIVE, PHASE2_TIMEOUT_MIN, REQUEST_DELAY } from './src/config.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let _currentHashtag = null;

async function run() {
    console.log('='.repeat(60));
    console.log('INSTAGRAM PROSPECTOR — Sequential Pipeline + AI Classification');
    console.log('='.repeat(60));

    // INIT
    console.log('\n[INIT] Starting...\n');
    await initSheets();
    await initBrowser();
    await refreshCookieStr();

    // Hashtags stored in column A of Instagram sheet (as #hashtag)
    const allHashtags = await readHashtags();
    if (allHashtags.length === 0) {
        console.log('[ERROR] No hashtags in sheet column A. Add as #muasemarang, #riasjogja, etc.');
        process.exit(1);
    }

    const nextIdx = 0;
    const visited = await readVisitedProfiles();

    let stats = { profiles: 0, clients: 0, errors: 0, aiProcessed: 0 };
    let globalErrorCount = 0;
    let phase2Start = Date.now();
    let postCount = 0;

    const hashtag = allHashtags[nextIdx % allHashtags.length];
    _currentHashtag = hashtag;

    console.log('-'.repeat(60));
    console.log(`[RUN] Hashtag: ${hashtag} | index: ${nextIdx}/${allHashtags.length}`);
    console.log('-'.repeat(60));

    await refreshCookieStr();

    // PHASE 1 — Scrape hashtag
    console.log('\n[PHASE 1] Scraping hashtag...\n');
    const posts = await scrapeHashtag(hashtag);
    console.log(`\n  → Found ${posts.length} posts\n`);

    if (posts.length === 0) {
        console.log('[PHASE 1] No posts found. Skipping.');
        await closeBrowser();
        printSummary(stats, hashtag, nextIdx, allHashtags.length);
        return;
    }

    // PHASE 2-4 — Loop posts: enrich profiles
    console.log('-'.repeat(60));
    console.log('[PHASE 2-4] Enriching profiles...');
    console.log('-'.repeat(60) + '\n');

    const enrichedBatch = []; // collected for AI batch
    const discoveryQueue = [];
    const seenInQueue = new Set();

    for (let i = 0; i < posts.length; i++) {
        const post = posts[i];

        // PHASE 8 — Every 20 posts: re-login
        if (postCount > 0 && postCount % 20 === 0) {
            console.log(`\n[PHASE 8] Re-login (count=${postCount})...`);
            await refreshCookieStr();
        }
        postCount++;

        // Phase 2 timeout
        const elapsedMin = (Date.now() - phase2Start) / 60000;
        if (elapsedMin >= (PHASE2_TIMEOUT_MIN || 60)) {
            console.log(`\n[STOP] ${elapsedMin.toFixed(1)} min timeout.`);
            break;
        }

        const postNum = i + 1;
        const shortcode = post.shortcode || '';
        const postUrl = `https://www.instagram.com/p/${shortcode}/`;
        console.log(`\n[POST ${postNum}/${posts.length}] ${shortcode}`);

        // Enrich post (oEmbed)
        const postData = await enrichPost(postUrl);
        if (!postData || !postData.username) {
            console.log(`  [SKIP] No username`);
            globalErrorCount++;
            continue;
        }

        const username = postData.username.toLowerCase();
        if (username === 'deovatta' || !username) {
            console.log(`  [SKIP] Own account`);
            continue;
        }

        const isNewProfile = !visited.has(username);

        // Indonesian check via post text
        const postText = ((postData.caption || '') + ' ' + (postData.hashtags || []).join(' ')).toLowerCase();
        if (!isIndonesian(postText, [], '')) {
            console.log(`  [SKIP] @${username} — not Indonesian`);
            continue;
        }

        // Enrich profile
        const profile = await enrichProfile(username, postData);
        if (!profile) {
            globalErrorCount++;
            if (globalErrorCount >= (MAX_API_ERRORS_CONSECUTIVE || 20)) {
                console.log(`\n[STOP] ${globalErrorCount} consecutive errors.`); break;
            }
            continue;
        }
        globalErrorCount = 0;

        // Indonesian check via profile
        if (!isIndonesian(profile.bio || '', [...(profile.hashtags || [])], profile.nativeLocation || '')) {
            console.log(`  [SKIP] @${username} — profile not Indonesian`);
            continue;
        }

        profile.sourceHashtag = hashtag;
        profile.via = 'hashtag';

        // Collect for AI batch
        if (isNewProfile) {
            enrichedBatch.push(profile);
            visited.add(username);
            stats.profiles++;
        }

        // Collect mentions + collabs
        const mentions = [...(postData.mentions || [])];
        const collabs = [...(postData.collabs || [])];

        for (const m of mentions) {
            const mLower = m.toLowerCase();
            if (!visited.has(mLower) && !seenInQueue.has(mLower)) {
                seenInQueue.add(mLower);
                discoveryQueue.push({ username: mLower, depth: 1, source: username });
            }
        }
        for (const c of collabs) {
            const cLower = c.toLowerCase();
            if (!visited.has(cLower) && !seenInQueue.has(cLower)) {
                seenInQueue.add(cLower);
                discoveryQueue.push({ username: cLower, depth: 1, source: username });
            }
        }
    }

    // PHASE 5 — AI batch classification
    console.log('\n' + '-'.repeat(60));
    console.log(`[PHASE 5] AI batch classification — ${enrichedBatch.length} profiles...`);
    console.log('-'.repeat(60) + '\n');

    const aiBatch = await classifyProfilesBatch(enrichedBatch);
    stats.aiProcessed = aiBatch.length;

    // PHASE 6 — Write AI-enriched profiles to sheet
    console.log('\n' + '-'.repeat(60));
    console.log(`[PHASE 6] Writing ${aiBatch.length} profiles to sheet...`);
    console.log('-'.repeat(60) + '\n');

    for (const profile of aiBatch) {
        await writeProfile(profile, visited);
        console.log(`  → @${profile.username} | ${profile.category} | ${profile.location} | WA: ${profile.whatsapp || 'N/A'}`);
    }

    // PHASE 7 — Comment extraction → client discovery
    console.log('\n' + '-'.repeat(60));
    console.log(`[PHASE 7] Comment extraction (${posts.slice(-10).length} posts)...`);
    console.log('-'.repeat(60) + '\n');

    const commentPosts = posts.slice(-10);

    for (let i = 0; i < commentPosts.length; i++) {
        const post = commentPosts[i];
        const shortcode = post.shortcode || '';
        const pNum = i + 1;
        console.log(`\n[COMMENT ${pNum}/${commentPosts.length}] ${shortcode}`);

        const postAuthor = (post.username || '').toLowerCase();
        const allComments = await fetchAllPostCommentsGraphQL(shortcode, 100);
        if (!allComments || allComments.length === 0) { console.log(`  → 0 comments`); continue; }
        console.log(`  → ${allComments.length} comments`);

        const clients = filterClients(allComments, postAuthor || null);
        console.log(`  → ${clients.length} potential clients`);

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
            console.log(`    [CLIENT] @${cUser}`);
        }

        await sleep(REQUEST_DELAY * 1000);
    }

    // PHASE 6b — Discovery queue (AI-enriched)
    console.log('\n' + '-'.repeat(60));
    console.log(`[PHASE 6b] Discovery queue (${discoveryQueue.length} profiles)...`);
    console.log('-'.repeat(60) + '\n');

    let discCount = 0, discErrors = 0, consecutiveSeen = 0, discPostCount = 0;
    const discoveryBatch = [];

    while (discoveryQueue.length > 0) {
        const item = discoveryQueue.shift();
        if (visited.has(item.username)) {
            consecutiveSeen++;
            if (consecutiveSeen >= 10) { console.log(`\n[STOP] 10 consecutive already-seen.`); break; }
            continue;
        }
        if (item.depth > (MAX_COLLAB_DEPTH || 2)) continue;

        visited.add(item.username);
        discCount++;

        if (discPostCount > 0 && discPostCount % 20 === 0) {
            console.log(`\n[PHASE 8] Re-login (discovery=${discCount})...`);
            await refreshCookieStr();
        }
        discPostCount++;

        console.log(`\n[DISCOVER ${discCount}] @${item.username} (via @${item.source}, depth=${item.depth})`);

        const profile = await enrichProfile(item.username);
        if (!profile) {
            discErrors++;
            if (discErrors >= (MAX_API_ERRORS_CONSECUTIVE || 20)) { console.log(`\n[STOP] ${discErrors} errors.`); break; }
            continue;
        }
        discErrors = 0;

        if (!isIndonesian(profile.bio || '', [...(profile.hashtags || [])], profile.nativeLocation || '')) {
            console.log(`  [SKIP] @${item.username} — not Indonesian`); continue;
        }

        profile.sourceHashtag = `collab via @${item.source}`;
        profile.via = 'discovery';

        discoveryBatch.push(profile);

        // Batch AI processing every 50 discovery profiles
        if (discoveryBatch.length >= 50) {
            const aiResults = await classifyProfilesBatch(discoveryBatch);
            for (const p of aiResults) {
                await writeProfile(p, visited);
                stats.aiProcessed++;
                console.log(`  → @${p.username} | ${p.category} | ${p.location}`);
            }
            discoveryBatch.length = 0;
        }
    }

    // Write remaining discovery profiles
    if (discoveryBatch.length > 0) {
        const aiResults = await classifyProfilesBatch(discoveryBatch);
        for (const p of aiResults) {
            await writeProfile(p, visited);
            stats.aiProcessed++;
            console.log(`  → @${p.username} | ${p.category} | ${p.location}`);
        }
    }

    await closeBrowser();
    printSummary(stats, hashtag, nextIdx, allHashtags.length);
}

function printSummary(stats, hashtag, idx, total) {
    console.log('\n' + '='.repeat(60));
    console.log('[DONE] SCAN COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Hashtag:   ${hashtag} (index ${idx} of ${total})`);
    console.log(`  Profiles:  ${stats.profiles}`);
    console.log(`  AI Processed: ${stats.aiProcessed}`);
    console.log(`  Clients:   ${stats.clients}`);
    console.log('='.repeat(60));
}

process.on('SIGINT', async () => {
    console.log('\n[ABORT] Closing...');
    await closeBrowser().catch(() => {});
    process.exit(1);
});

run().catch(async (e) => {
    console.error('[FATAL]', e.message);
    await closeBrowser().catch(() => {});
    process.exit(1);
});
