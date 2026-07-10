/**
 * Instagram Prospector - Sequential Pipeline v2
 *
 * Pipeline flow per hashtag:
 * PHASE 1  — Scrape hashtag → get all post data
 * PHASE 2  — Loop posts sequentially (index 0→N)
 * PHASE 3  — Check Indonesian indicators
 * PHASE 4  — Extract hashtags → write new ones to VendorHashtags sheet
 * PHASE 5  — Enrich profile → classify (competitor/vendor/client)
 * PHASE 6  — Write to correct sheet immediately; collect mentions+collab
 * PHASE 7  — Collect last 20 post URLs for comment extraction
 * PHASE 8  — Loop posts: extract comments → filter clients → write immediately
 * PHASE 9  — Collab/mention queue: enrich each → PHASE 6 (depth up to 2)
 * PHASE 10 — Every 20 posts: re-login to refresh session cookies
 */

import {
    initBrowser, closeBrowser, refreshCookieStr,
    enrichPost, scrapeHashtag, fetchAllPostCommentsGraphQL,
} from './src/scraper.js';
import { enrichProfile } from './src/enricher.js';
import { filterClients } from './src/comments.js';
import {
    initSheets, readHashtags, readVisitedProfiles, findNextHashtagIndex,
    writeProfile, writeClientFromComment, writeNewHashtag,
    persistState, clearExecutingMarkers, markHashtagExecuting, markHashtagDone,
} from './src/sheets.js';
import { isIndonesian } from './src/classifier.js';
import { MAX_COLLAB_DEPTH, MAX_API_ERRORS_CONSECUTIVE, PHASE2_TIMEOUT_MIN } from './src/config.js';

let _currentHashtag = null;

async function run() {
    console.log('='.repeat(60));
    console.log('INSTAGRAM PROSPECTOR v2 — Sequential Pipeline');
    console.log('='.repeat(60));

    // INIT
    console.log('\n[INIT] Starting...\n');
    await initSheets();
    await initBrowser();
    await refreshCookieStr();

    const approvedHashtags = await readHashtags();
    if (approvedHashtags.length === 0) {
        console.log('[ERROR] No approved hashtags in VendorHashtags sheet');
        process.exit(1);
    }

    await clearExecutingMarkers();
    const visited = await readVisitedProfiles();
    const hashtagIdx = await findNextHashtagIndex(approvedHashtags);

    let stats = { competitors: 0, vendors: 0, clients: 0, hashtags: 0, errors: 0 };
    let globalErrorCount = 0;
    let phase2Start = Date.now();
    let postCount = 0;

    const hashtag = approvedHashtags[hashtagIdx];
    _currentHashtag = hashtag;

    console.log('-'.repeat(60));
    console.log(`[RUN] Hashtag: #${hashtag} | index: ${hashtagIdx}`);
    console.log('-'.repeat(60));

    await markHashtagExecuting(hashtag);
    await refreshCookieStr();

    // PHASE 1 — Scrape hashtag
    console.log('\n[PHASE 1] Scraping hashtag...\n');
    const posts = await scrapeHashtag(hashtag);
    console.log(`\n  → Found ${posts.length} posts\n`);

    if (posts.length === 0) {
        console.log('[PHASE 1] No posts found. Skipping hashtag.');
        await markHashtagDone(hashtag, true);
        await closeBrowser();
        await persistState();
        printSummary(stats, hashtag, hashtagIdx, hashtagIdx + 1, approvedHashtags.length);
        return;
    }

    // PHASE 2-6 — Loop posts sequentially
    console.log('-'.repeat(60));
    console.log('[PHASE 2-6] Processing posts sequentially...');
    console.log('-'.repeat(60) + '\n');

    const collabQueue = [];
    const seenInQueue = new Set();
    const vendorPostUrls = new Set();

    for (let i = 0; i < posts.length; i++) {
        const post = posts[i];

        // PHASE 10 — Every 20 posts: re-login
        if (postCount > 0 && postCount % 20 === 0) {
            console.log(`\n[PHASE 10] Re-login every 20 posts (count=${postCount})...`);
            await refreshCookieStr();
        }
        postCount++;

        // Phase 2 timeout
        const elapsedMin = (Date.now() - phase2Start) / 60000;
        if (elapsedMin >= (PHASE2_TIMEOUT_MIN || 60)) {
            console.log(`\n[STOP] Phase 2-6: ${elapsedMin.toFixed(1)} min timeout.`);
            break;
        }

        const postNum = i + 1;
        const shortcode = post.shortcode || '';
        const postUrl = `https://www.instagram.com/p/${shortcode}/`;
        console.log(`\n[POST ${postNum}/${posts.length}] ${shortcode}`);

        const username = (post.username || '').toLowerCase();
        if (username === 'deovatta' || !username) {
            console.log(`  [SKIP] Own account or empty username`);
            continue;
        }

        // PHASE 2 — Enrich post
        const postData = await enrichPost(postUrl);
        if (!postData || !postData.username) {
            console.log(`  [SKIP] No username from post`);
            globalErrorCount++;
            continue;
        }

        const enrichedUsername = postData.username.toLowerCase();
        if (enrichedUsername === 'deovatta') continue;

        const isNewProfile = !visited.has(enrichedUsername);

        // PHASE 3 — Indonesian check via hashtags/caption
        const postText = ((postData.caption || '') + ' ' + (postData.hashtags || []).join(' ')).toLowerCase();
        if (!isIndonesian(postText, [], '')) {
            console.log(`  [SKIP] @${enrichedUsername} — not Indonesian`);
            continue;
        }

        // PHASE 4 — Extract hashtags
        for (const tag of postData.hashtags || []) {
            await writeNewHashtag(tag, enrichedUsername);
        }

        // PHASE 5 — Enrich profile → classify
        const profile = await enrichProfile(enrichedUsername, postData);
        if (!profile) {
            globalErrorCount++;
            if (globalErrorCount >= (MAX_API_ERRORS_CONSECUTIVE || 20)) {
                console.log(`\n[STOP] Phase 2-6: ${globalErrorCount} consecutive errors.`);
                break;
            }
            continue;
        }

        globalErrorCount = 0;

        // PHASE 3b — Indonesian check via profile
        if (!isIndonesian(profile.bio || '', [...(profile.hashtags || [])], profile.nativeLocation || '')) {
            console.log(`  [SKIP] @${enrichedUsername} — profile not Indonesian`);
            continue;
        }

        // PHASE 6 — Write to sheet
        const typeKey = profile.type || 'client';
        const isClient = typeKey === 'client';

        if (isNewProfile) {
            await writeProfile(profile, visited);
            visited.add(enrichedUsername);
            if (typeKey === 'competitor') stats.competitors++;
            else if (typeKey === 'vendor') stats.vendors++;
            else stats.clients++;
            console.log(`  [SAVED] @${enrichedUsername} → ${typeKey}`);
        } else {
            console.log(`  [REVISIT] @${enrichedUsername} — already saved`);
        }

        // Collect mentions + collabs
        if (!isClient) {
            const mentions = [...(postData.mentions || [])];
            const collabs = [...(postData.collabs || [])];

            const profilePostUrls = [...(profile.profilePostUrls || [])];
            if (profilePostUrls.length > 0) {
                const MAX_VENDOR_POSTS = 12;
                for (const url of profilePostUrls.slice(0, MAX_VENDOR_POSTS)) {
                    vendorPostUrls.add(url);
                }
                console.log(`  [NESTED] Collected ${Math.min(profilePostUrls.length, MAX_VENDOR_POSTS)} posts from @${enrichedUsername}`);
            }

            for (const m of mentions) {
                const mLower = m.toLowerCase();
                if (!visited.has(mLower) && !seenInQueue.has(mLower)) {
                    seenInQueue.add(mLower);
                    collabQueue.push({ username: mLower, depth: 1, source: enrichedUsername });
                }
            }
            for (const c of collabs) {
                const cLower = c.toLowerCase();
                if (!visited.has(cLower) && !seenInQueue.has(cLower)) {
                    seenInQueue.add(cLower);
                    collabQueue.push({ username: cLower, depth: 1, source: enrichedUsername });
                }
            }
        }
    }

    // PHASE 7 — Collect posts for Phase 8
    console.log('\n' + '-'.repeat(60));
    const commentPosts = posts.slice(-20).map(p => ({ ...p, _source: 'hashtag' }));
    const vendorPostArray = [...vendorPostUrls].map(url => {
        const sc = url.split('/p/')[1]?.replace(/\/$/, '') || '';
        return { shortcode: sc, postUrl: url, username: '', _source: 'vendor' };
    });
    commentPosts.push(...vendorPostArray);
    console.log(`[PHASE 7] ${posts.length} hashtag + ${vendorPostUrls.size} vendor = ${commentPosts.length} for Phase 8`);
    console.log('-'.repeat(60) + '\n');

    // PHASE 8 — Comment extraction → client discovery
    console.log('-'.repeat(60));
    console.log('[PHASE 8] Comment extraction → client discovery...');
    console.log('-'.repeat(60) + '\n');

    let commentCount = 0;

    for (let i = 0; i < commentPosts.length; i++) {
        const post = commentPosts[i];
        const shortcode = post.shortcode || '';
        const postUrl = `https://www.instagram.com/p/${shortcode}/`;
        const pNum = i + 1;
        const sourceTag = post._source === 'vendor' ? ' [VENDOR]' : '';
        console.log(`\n[COMMENT ${pNum}/${commentPosts.length}${sourceTag}] ${shortcode}`);

        const postAuthor = (post.username || '').toLowerCase();
        const allComments = await fetchAllPostCommentsGraphQL(shortcode, 100);
        if (!allComments || allComments.length === 0) {
            console.log(`  → 0 comments`);
            continue;
        }
        console.log(`  → ${allComments.length} comments${postAuthor ? ` from @${postAuthor}` : ''}`);

        const clients = filterClients(allComments, postAuthor || null);
        if (clients.length === 0) {
            console.log(`  → 0 filtered clients`);
            continue;
        }
        console.log(`  → ${clients.length} potential clients`);

        for (const client of clients) {
            const cUser = client.username.toLowerCase();
            if (visited.has(cUser)) continue;
            const clientData = {
                username: cUser, via: 'comment', source: hashtag,
                commentText: (client.text || '').slice(0, 200),
                location: '', profileUrl: `https://instagram.com/${cUser}/`,
            };
            await writeClientFromComment(clientData, visited);
            stats.clients++;
            commentCount++;
            console.log(`    [CLIENT SAVED] @${cUser} (score: ${client.score})`);
        }
    }

    console.log(`\n  → ${commentCount} clients saved from comments\n`);

    // PHASE 9 — Collab/mention queue
    console.log('\n' + '-'.repeat(60));
    console.log(`[PHASE 9] Collab/mention discovery (${collabQueue.length} queued)...`);
    console.log('-'.repeat(60) + '\n');

    let discCount = 0, discErrors = 0, consecutiveSeen = 0, discPostCount = 0;

    while (collabQueue.length > 0) {
        const item = collabQueue.shift();
        if (visited.has(item.username)) {
            consecutiveSeen++;
            if (consecutiveSeen >= 10) { console.log(`\n[STOP] Phase 9: 10 consecutive already-seen.`); break; }
            continue;
        }
        if (item.depth > (MAX_COLLAB_DEPTH || 2)) continue;

        visited.add(item.username);
        discCount++;

        if (discPostCount > 0 && discPostCount % 20 === 0) {
            console.log(`\n[PHASE 10] Re-login (discovery count=${discCount})...`);
            await refreshCookieStr();
        }
        discPostCount++;

        console.log(`\n[DISCOVER ${discCount}] @${item.username} (via @${item.source}, depth=${item.depth})`);

        const profile = await enrichProfile(item.username);
        if (!profile) {
            discErrors++;
            globalErrorCount++;
            if (discErrors >= (MAX_API_ERRORS_CONSECUTIVE || 20)) {
                console.log(`\n[STOP] Phase 9: ${discErrors} consecutive errors.`); break;
            }
            continue;
        }

        discErrors = 0;
        globalErrorCount = 0;

        if (!isIndonesian(profile.bio || '', [...(profile.hashtags || [])], profile.nativeLocation || '')) {
            console.log(`  [SKIP] @${item.username} — not Indonesian`); continue;
        }

        const typeKey = profile.type || 'client';
        await writeProfile(profile, visited);
        if (typeKey === 'competitor') stats.competitors++;
        else if (typeKey === 'vendor') stats.vendors++;
        else stats.clients++;
        console.log(`  [SAVED] @${item.username} → ${typeKey}`);

        if (item.depth < (MAX_COLLAB_DEPTH || 2)) {
            for (const m of [...(profile.mentions || []), ...(profile.collabs || [])]) {
                const mLower = m.toLowerCase();
                if (!visited.has(mLower) && !seenInQueue.has(mLower)) {
                    seenInQueue.add(mLower);
                    collabQueue.push({ username: mLower, depth: item.depth + 1, source: item.username });
                }
            }
        }
    }

    // PHASE 11 — Mark done
    await markHashtagDone(hashtag, true);
    const nextIdx = (hashtagIdx + 1) % approvedHashtags.length;

    await closeBrowser();
    await persistState();

    printSummary(stats, hashtag, hashtagIdx, nextIdx, approvedHashtags.length);
}

function printSummary(stats, hashtag, lastIdx, nextIdx, totalHashtags) {
    console.log('\n' + '='.repeat(60));
    console.log('[DONE] SCAN COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Hashtag:   #${hashtag} (index ${lastIdx} of ${totalHashtags})`);
    console.log(`  Competitors: ${stats.competitors}`);
    console.log(`  Vendors:    ${stats.vendors}`);
    console.log(`  Clients:    ${stats.clients}`);
    console.log(`  Index:      ${lastIdx} → ${nextIdx}`);
    console.log(`  Next run:   hashtag index ${nextIdx}`);
    console.log('='.repeat(60));
}

process.on('SIGINT', async () => {
    console.log('\n[ABORT] Closing...');
    if (_currentHashtag) await markHashtagDone(_currentHashtag, false).catch(() => {});
    await closeBrowser().catch(() => {});
    process.exit(1);
});

run().catch(async (e) => {
    console.error('[FATAL]', e.message);
    await closeBrowser().catch(() => {});
    process.exit(1);
});
