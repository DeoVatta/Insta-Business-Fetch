/**
 * Instagram Prospector - Profile Enricher
 *
 * Combines Playwright profile page + API post data to build complete profile.
 * No instagrapi npm — uses Playwright + /api/v1/media/{id}/info/
 */

import {
    enrichProfileFromPage,
    enrichPostFromApi,
    enrichPostsBatch,
    scrapeProfilePosts,
    initBrowser,
    fetchUserFeed,
} from './scraper.js';
import { classifyAccount, classifyFromHashtags, detectCategory, detectLocation, calculateEngagement } from './classifier.js';
import { REQUEST_DELAY, PROFILES_PER_HASHTAG } from './config.js';

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Enrich multiple profiles in parallel batches (for Phase 2 bulk processing).
 * @param {Array} posts - Array of post objects
 * @param {number} maxProfiles - Max profiles to process
 * @param {number} concurrency - Max concurrent browser sessions
 * @param {number} batchDelayMs - Delay between batches (ms)
 */
async function enrichProfilesBatch(posts, maxProfiles, concurrency = 2, batchDelayMs = 3000) {
    const results = [];
    const unique = [];
    const seen = new Set();
    for (const p of posts) {
        // Shortcode is always present; username may be empty → OR-safe
        const key = p.shortcode;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(p);
        if (unique.length >= maxProfiles) break;
    }

    for (let i = 0; i < unique.length; i += concurrency) {
        const batch = unique.slice(i, i + concurrency);
        console.log(`  [BATCH] Enriching ${batch.length} profiles (${i + 1}–${i + batch.length})`);
        const batchResults = await Promise.all(batch.map(p => enrichProfile(p.username, p)));
        results.push(...batchResults.filter(Boolean));
        if (i + concurrency < unique.length) {
            await sleep(batchDelayMs);
        }
    }
    return results;
}

// ============== ENRICH PROFILE ==============
/**
 * Calculate engagement rate from an array of post stats.
 * Formula: (avg_likes + avg_comments) / followers * 100
 * Uses UpDog method: average engagement per post / followers.
 */
function calcEngagementFromPosts(posts, followers) {
    if (!followers || followers === 0 || !posts || posts.length === 0) return 0;
    const totalLikes = posts.reduce((sum, p) => sum + (p.likeCount || 0), 0);
    const totalComments = posts.reduce((sum, p) => sum + (p.commentCount || 0), 0);
    const avgEngagement = (totalLikes + totalComments) / posts.length;
    return parseFloat(((avgEngagement / followers) * 100).toFixed(2));
}

/**
 * Full profile enrichment:
 * 1. Get profile data from profile page (bio, followers, following, posts, category)
 * 2. Scrape recent posts from profile grid (for collab/mention discovery)
 * 3. Fetch user feed via REST API (for accurate engagement rate)
 * 4. Classify: competitor/vendor/client
 * 5. Calculate engagement from aggregated post stats (UpDog method)
 */
async function enrichProfile(username, postData = null) {
    try {
        // Get profile page data
        const profile = await enrichProfileFromPage(username);

        if (!profile || profile.followers === 0) {
            console.log(`  [WARN] Could not load profile @${username}`);
        } else {
            console.log(`  [PROFILE] @${username} | ${profile.followers} followers | ${profile.posts} posts`);
            console.log(`  [BIO] ${(profile.bio || '').substring(0, 80)}`);
        }

        // Merge with post data if provided
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

        // Scrape posts from profile for collab/mention discovery
        try {
            const profilePostUrls = await scrapeProfilePosts(username, 12);
            console.log(`  [POSTS] Found ${profilePostUrls.length} posts on profile`);
            profile.profilePostUrls = profilePostUrls;

            // Enrich posts in parallel batches (3 concurrent, 2s between batches)
            // Collect all likes/comments for engagement calculation
            if (profilePostUrls.length > 0) {
                const enrichedPosts = await enrichPostsBatch(profilePostUrls.slice(0, 6), 3, 2000);
                for (const pd of enrichedPosts) {
                    pd.hashtags.forEach(h => profile.hashtags.add(h));
                    pd.mentions.forEach(m => profile.mentions.add(m));
                    pd.collabs.forEach(c => profile.collabs.add(c));
                    // Aggregate likes/comments from each post
                    profile.postLikes += pd.likes || 0;
                    profile.postComments += pd.comments || 0;
                }
            }
        } catch (e) {
            console.log(`  [WARN] Could not scrape profile posts @${username}: ${e.message}`);
        }

        // Fetch user feed via REST API for accurate engagement rate
        // This gives us like_count + comment_count for each recent post
        if (profile.followers > 0) {
            try {
                const feedPosts = await fetchUserFeed(username, 18);
                if (feedPosts.length > 0) {
                    profile.feedPosts = feedPosts;
                    profile.engagementRate = calcEngagementFromPosts(feedPosts, profile.followers);
                    const avgLikes = (feedPosts.reduce((s, p) => s + (p.likeCount || 0), 0) / feedPosts.length).toFixed(0);
                    const avgComments = (feedPosts.reduce((s, p) => s + (p.commentCount || 0), 0) / feedPosts.length).toFixed(1);
                    console.log(`  [ENGAGEMENT FEED] ${feedPosts.length} posts avg | ${avgLikes} likes + ${avgComments} comments | ${profile.engagementRate}%`);
                } else {
                    // Fallback to aggregated single-post engagement
                    profile.engagementRate = calculateEngagement(
                        profile.postLikes,
                        profile.postComments,
                        profile.followers
                    );
                }
            } catch (e) {
                console.log(`  [WARN] Could not fetch user feed @${username}: ${e.message}`);
                profile.engagementRate = calculateEngagement(
                    profile.postLikes,
                    profile.postComments,
                    profile.followers
                );
            }
        } else {
            profile.engagementRate = 0;
        }

        // Classify
        const fullText = (profile.bio || '') + ' ' + (profile.displayName || '') + ' ' + (profile.category || '');
        profile.type = classifyAccount(profile.bio || '', profile.displayName || '');
        profile.location = detectLocation(profile.bio || '', profile.displayName || '', profile.nativeLocation || '');
        profile.category = detectCategory(profile.bio || '', profile.displayName || '', profile.type);

        // If bio is empty OR type is still client, try classify from hashtags
        const hasBio = (profile.bio || '').trim().length > 5;
        if (!hasBio || (profile.type === 'client' && profile.hashtags.size > 0)) {
            profile.type = classifyFromHashtags([...profile.hashtags]);
            profile.category = detectCategory([...profile.hashtags].join(' '), '', profile.type);
        }

        console.log(`  [CLASSIFY] ${profile.type} | ${profile.category} | ${profile.location || 'N/A'}`);
        console.log(`  [ENGAGEMENT] ${profile.engagementRate}% (${profile.followers} followers)`);
        console.log(`  [TAGS] Hashtags: ${[...profile.hashtags].slice(0, 5).join(' ')}`);
        console.log(`  [DISC] Mentions: ${[...profile.mentions].slice(0, 3).join(', ') || 'none'}`);
        console.log(`  [DISC] Collabs: ${[...profile.collabs].slice(0, 3).join(', ') || 'none'}`);

        return profile;

    } catch (e) {
        console.log(`  [ERROR] Failed to enrich @${username}: ${e.message}`);
        return null;
    }
}

// ============== EXPORTS ==============
export { enrichProfile, enrichProfilesBatch, initBrowser };
