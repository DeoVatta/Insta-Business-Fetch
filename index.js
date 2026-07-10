/**
 * Instagram Prospector - Sequential Pipeline + AI Classification
 *
 * Two sheets:
 * - "Instagram" — profile data
 * - "Hashtags"  — hashtag tracking (only AI-approved business hashtags)
 *
 * Flow:
 * PHASE 1  — Scrape hashtag → get all post data
 * PHASE 2  — Loop posts: enrich profiles
 * PHASE 3  — Collect ALL hashtags from posts (temp, in-memory)
 * PHASE 4  — AI batch: classify hashtags → only write business-related to Hashtags sheet
 * PHASE 5  — AI batch: classify profiles
 * PHASE 6  — Write profiles to Instagram sheet
 * PHASE 7  — Comment extraction → client discovery
 * PHASE 8  — Discovery queue (AI-enriched)
 * PHASE 9  — Every 20 posts: re-login
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

let _currentHashtag = null;

async function run() {
    console.log('='.repeat(60));
    console.log('INSTAGRAM PROSPECTOR — Pipeline + AI Classification');
    console.log('='.repeat(60));

    // INIT
    console.log('\n[INIT] Starting...\n');
    await initSheets();
    await initBrowser();
    await refreshCookieStr();

    // Read hashtags to process from Hashtags sheet (status != Executed)
    const pendingHashtags = await readHashtags();
    if (pendingHashtags.length === 0) {
        console.log('[ERROR] No pending hashtags in Hashtags sheet. Add hashtags with status=Pending.');
        process.exit(1);
    }

    const visited = await readVisitedProfiles();
    const hashtagsInSheet = await readHashtagsInSheet(); // for dedup when writing

    let stats = { profiles: 0, clients: 0, errors: 0, aiProfiles: 0, hashtagsWritten: 0 };
    let globalErrorCount = 0;
    let phase2Start = Date.now();
    let postCount = 0;

    // Process ONE hashtag per run
    const hashtag = pendingHashtags[0];
    _currentHashtag = hashtag;

    console.log('-'.repeat(60));
    console.log(`[RUN] Hashtag: ${hashtag} | 1/${pendingHashtags.length} pending`);
    console.log('-'.repeat(60));

    await markHashtagStatus(hashtag, 'Executing');
    await refreshCookieStr();

    // PHASE 1 — Scrape
    console.log('\n[PHASE 1] Scraping hashtag...\n');
    const posts = await scrapeHashtag(hashtag);
    console.log(`\n  → Found ${posts.length} posts\n`);

    if (posts.length === 0) {
        console.log('[PHASE 1] No posts found. Skipping.');
        await markHashtagStatus(hashtag, 'Executed');
        await closeBrowser();
        printSummary(stats, hashtag);
        return;
    }

    // PHASE 2 — Enrich + collect hashtags
    console.log('-'.repeat(60));
    console.log('[PHASE 2] Enriching profiles + collecting hashtags...');
    console.log('-'.repeat(60) + '\n');

    const enrichedBatch = [];
    const discoveryQueue = [];
    const seenInQueue = new Set();
    const allHashtags = new Set(); // collected for AI classification
    const hashtagCounts = {}; // { muasemarang: 5, ... }

    for (let i = 0; i < posts.length; i++) {
        const post = posts[i];

        // PHASE 9 — Re-login every 20 posts
        if (postCount > 0 && postCount % 20 === 0) {
            console.log(`\n[PHASE 9] Re-login (count=${postCount})...`);
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

        // Enrich post (oEmbed)
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

        // Indonesian check via post
        const postText = ((postData.caption || '') + ' ' + (postData.hashtags || []).join(' ')).toLowerCase();
        if (!isIndonesian(postText, [], '')) { console.log(`  [SKIP] @${username} — not Indonesian`); continue; }

        // Enrich profile
        const profile = await enrichProfile(username, postData);
        if (!profile) { globalErrorCount++; continue; }
        globalErrorCount = 0;

        // Indonesian check via profile
        if (!isIndonesian(profile.bio || '', [...(profile.hashtags || [])], profile.nativeLocation || '')) {
            console.log(`  [SKIP] @${username} — profile not Indonesian`); continue;
        }

        profile.sourceHashtag = hashtag;
        profile.via = 'hashtag';

        if (isNewProfile) {
            enrichedBatch.push(profile);
            visited.add(username);
            stats.profiles++;
        }

        // Collect mentions + collabs
        for (const m of [...(postData.mentions || []), ...(postData.collabs || [])]) {
            const mLower = m.toLowerCase();
            if (!visited.has(mLower) && !seenInQueue.has(mLower)) {
                seenInQueue.add(mLower);
                discoveryQueue.push({ username: mLower, depth: 1, source: username });
            }
        }
    }

    // PHASE 3 — AI classify hashtags → write only business ones to Hashtags sheet
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

    // PHASE 4 — AI classify profiles
    console.log('\n' + '-'.repeat(60));
    console.log(`[PHASE 4] AI profile classification — ${enrichedBatch.length} profiles...`);
    console.log('-'.repeat(60) + '\n');

    const aiProfiles = await classifyProfilesBatch(enrichedBatch);
    stats.aiProfiles = aiProfiles.length;

    // PHASE 5 — Write profiles to Instagram sheet
    console.log('\n' + '-'.repeat(60));
    console.log(`[PHASE 5] Writing ${aiProfiles.length} profiles to Instagram sheet...`);
    console.log('-'.repeat(60) + '\n');

    for (const profile of aiProfiles) {
        await writeProfile(profile, visited);
    }

    // PHASE 6 — Comment extraction → client discovery
    console.log('\n' + '-'.repeat(60));
    console.log(`[PHASE 6] Comment extraction (${posts.slice(-10).length} posts)...`);
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

    // PHASE 7 — Discovery queue
    console.log('\n' + '-'.repeat(60));
    console.log(`[PHASE 7] Discovery queue (${discoveryQueue.length} profiles)...`);
    console.log('-'.repeat(60) + '\n');

    let discCount = 0, discErrors = 0, consecutiveSeen = 0, discPostCount = 0;
    const discoveryBatch = [];

    while (discoveryQueue.length > 0) {
        const item = discoveryQueue.shift();
        if (visited.has(item.username)) { consecutiveSeen++; if (consecutiveSeen >= 10) break; continue; }
        if (item.depth > (MAX_COLLAB_DEPTH || 2)) continue;

        visited.add(item.username);
        discCount++;

        if (discPostCount > 0 && discPostCount % 20 === 0) {
            console.log(`\n[PHASE 9] Re-login (discovery=${discCount})...`);
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

        discoveryBatch.push(profile);

        // Batch AI every 50
        if (discoveryBatch.length >= 50) {
            const aiResults = await classifyProfilesBatch(discoveryBatch);
            for (const p of aiResults) {
                await writeProfile(p, visited);
                stats.aiProfiles++;
            }
            discoveryBatch.length = 0;
        }
    }

    // Flush remaining discovery
    if (discoveryBatch.length > 0) {
        const aiResults = await classifyProfilesBatch(discoveryBatch);
        for (const p of aiResults) {
            await writeProfile(p, visited);
            stats.aiProfiles++;
        }
    }

    // Mark hashtag done
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
