/**
 * Instagram Prospector - Profile Enricher
 *
 * Combines Playwright profile page + oEmbed post data to build complete profile.
 */

import {
    enrichProfileFromPage,
    enrichPostsBatch,
    scrapeProfilePosts,
} from './scraper.js';
import { classifyAccount, classifyFromHashtags, detectCategory, detectLocation, calculateEngagement } from './classifier.js';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function enrichProfilesBatch(posts, maxProfiles, concurrency = 2, batchDelayMs = 3000) {
    const results = [];
    const unique = [];
    const seen = new Set();
    for (const p of posts) {
        const key = p.shortcode;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(p);
        if (unique.length >= maxProfiles) break;
    }

    for (let i = 0; i < unique.length; i += concurrency) {
        const batch = unique.slice(i, i + concurrency);
        console.log(`  [BATCH] Enriching ${batch.length} profiles (${i + 1}-${i + batch.length})`);
        const batchResults = await Promise.all(batch.map(p => enrichProfile(p.username, p)));
        results.push(...batchResults.filter(Boolean));
        if (i + concurrency < unique.length) await sleep(batchDelayMs);
    }
    return results;
}

async function enrichProfile(username, postData = null) {
    try {
        const profile = await enrichProfileFromPage(username);

        if (!profile || profile.followers === 0) {
            console.log(`  [WARN] Could not load profile @${username}`);
        } else {
            console.log(`  [PROFILE] @${username} | ${profile.followers} followers | ${profile.posts} posts`);
            console.log(`  [BIO] ${(profile.bio || '').substring(0, 80)}`);
        }

        if (postData) {
            profile.hashtags = new Set(postData.hashtags || []);
            profile.mentions = new Set((postData.mentions || []).map(m => m.toLowerCase()));
            profile.collabs = new Set(postData.collabs || []);
            profile.postLikes = postData.likes || 0;
            profile.postComments = postData.comments || 0;
            profile.caption = postData.caption || '';
        } else {
            profile.hashtags = new Set();
            profile.mentions = new Set();
            profile.collabs = new Set();
            profile.postLikes = 0;
            profile.postComments = 0;
        }

        try {
            const profilePostUrls = await scrapeProfilePosts(username, 12);
            console.log(`  [POSTS] Found ${profilePostUrls.length} posts on profile`);
            profile.profilePostUrls = profilePostUrls;
            if (profilePostUrls.length > 0) {
                const enrichedPosts = await enrichPostsBatch(profilePostUrls.slice(0, 6), 3, 2000);
                for (const pd of enrichedPosts) {
                    pd.hashtags.forEach(h => profile.hashtags.add(h));
                    pd.mentions.forEach(m => profile.mentions.add(m));
                    pd.collabs.forEach(c => profile.collabs.add(c));
                }
            }
        } catch (e) {
            console.log(`  [WARN] Could not scrape profile posts @${username}: ${e.message}`);
        }

        profile.type = classifyAccount(profile.bio || '', profile.displayName || '');
        profile.location = detectLocation(profile.bio || '', profile.displayName || '', profile.nativeLocation || '');
        profile.category = detectCategory(profile.bio || '', profile.displayName || '', profile.type);

        if (profile.followers > 0) {
            profile.engagementRate = calculateEngagement(profile.postLikes, profile.postComments, profile.followers);
        } else {
            profile.engagementRate = 0;
        }

        const hasBio = (profile.bio || '').trim().length > 5;
        if (!hasBio || (profile.type === 'client' && profile.hashtags.size > 0)) {
            profile.type = classifyFromHashtags([...profile.hashtags]);
            profile.category = detectCategory([...profile.hashtags].join(' '), '', profile.type);
        }

        console.log(`  [CLASSIFY] ${profile.type} | ${profile.category} | ${profile.location || 'N/A'}`);
        console.log(`  [ENGAGEMENT] ${profile.engagementRate}% (${profile.postLikes} likes, ${profile.postComments} comments / ${profile.followers} followers)`);
        console.log(`  [TAGS] Hashtags: ${[...profile.hashtags].slice(0, 5).join(' ')}`);
        console.log(`  [DISC] Mentions: ${[...profile.mentions].slice(0, 3).join(', ') || 'none'}`);
        console.log(`  [DISC] Collabs: ${[...profile.collabs].slice(0, 3).join(', ') || 'none'}`);

        return profile;
    } catch (e) {
        console.log(`  [ERROR] Failed to enrich @${username}: ${e.message}`);
        return null;
    }
}

export { enrichProfile, enrichProfilesBatch };
