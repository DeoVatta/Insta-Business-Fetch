/**
 * Instagram Prospector - Phase 1: Hashtag Discovery + Post Enrichment
 *
 * Confirmed working methods:
 * 1. Playwright → /explore/search/keyword/?q=%23{hashtag} → post URLs
 * 2. HTTP API → /api/v1/media/{mediaId}/info/ → full post data
 * 3. Playwright → /{username}/ → profile data (bio, followers, following)
 * 4. Playwright → profile page → scroll → post grid URLs
 *
 * Cookie path: ../instagram-cookies.json (parent directory)
 */

import { chromium } from 'playwright';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { REQUEST_DELAY, NAVIGATE_DELAY, MAX_SCROLL_HASHTAG, POSTS_PER_HASHTAG, PROFILES_PER_HASHTAG } from './config.js';
import { ensureAuth } from './instagram-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Safe wait — always resolves (never throws), returns early if page is gone
async function safeWait(ms) {
    try {
        if (!_page || _page.isClosed()) return;
        await _page.waitForTimeout(ms);
    } catch (_) {}
}

// ============== SHORTCODE → MEDIA ID ==============
function decodeShortcode(shortcode) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let n = 0n;
    for (const char of shortcode) { n = n * 64n + BigInt(alphabet.indexOf(char)); }
    return n.toString();
}

// ============== HTTP CLIENT ==============
let _cookies = null;
let _cookieStr = null;
let _csrftoken = null;
let _mobileHeaders = null;

function loadCookies() {
    if (_cookies) return;
    // __dirname = instagram/src/ → go up 1 level to instagram/ → ./instagram-cookies.json
    const cookieFile = path.join(__dirname, '..', 'instagram-cookies.json');
    _cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf-8'));
    _cookieStr = _cookies.map(c => c.name + '=' + c.value).join('; ');
    _csrftoken = _cookies.find(c => c.name === 'csrftoken')?.value || '';

    // Mobile API headers (for comment fetching - works with session cookies only, no HMAC needed)
    _mobileHeaders = {
        'User-Agent': 'Instagram 276.0.0.0.0 Android (Android/13; SDK 33; x86; Xiaomi Redmi Note 11)',
        'Cookie': _cookieStr,
        'X-CSRFToken': _csrftoken,
        'X-IG-App-ID': '1217981644879628',
        'X-IG-App-Locale': 'en_US',
        'X-IG-Device-Locale': 'en_US',
        'Accept': 'application/json, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.instagram.com/',
    };
}

function igFetch(url, mobileHeaders = false) {
    return new Promise((resolve, reject) => {
        loadCookies();
        const u = new URL(url);
        const headers = mobileHeaders ? { ..._mobileHeaders } : {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Cookie': _cookieStr,
            'X-CSRFToken': _csrftoken,
            'X-IG-App-ID': '936619743392459',
            'Accept': 'application/json, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.instagram.com/',
        };
        const opts = { hostname: u.hostname, path: u.pathname + u.search, headers };
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', err => {
            // Retry once on DNS/connection errors
            setTimeout(() => {
                const retryReq = mod.request(opts, res2 => {
                    let data2 = '';
                    res2.on('data', c => data2 += c);
                    res2.on('end', () => resolve({ status: res2.statusCode, body: data2 }));
                });
                retryReq.on('error', e2 => reject(e2));
                retryReq.on('timeout', () => { retryReq.destroy(); reject(new Error('timeout')); });
                retryReq.setTimeout(15000);
                retryReq.end();
            }, 3000);
        });
        req.setTimeout(15000);
        req.end();
    });
}

// ============== POST COMMENTS (GraphQL - confirmed working 2025) ==============
/**
 * Fetch comments via GraphQL (web API).
 * query_hash: bc3296d1ce80a24b1b6e40b1e72903f5 (stable, confirmed working)
 * Works with session cookies + desktop headers (no HMAC signing needed).
 *
 * Returns: { comments, pageInfo: { hasNextPage, endCursor }, totalCount }
 */
async function fetchPostCommentsGraphQL(shortcode, after = '') {
    await sleep(REQUEST_DELAY * 1000);
    const variables = JSON.stringify({ shortcode, first: 50, after });
    const url = `https://www.instagram.com/graphql/query/?query_hash=bc3296d1ce80a24b1b6e40b1e72903f5&variables=${encodeURIComponent(variables)}`;
    let res = await igFetch(url);

    // Retry once with fresh auth on auth failure (stale sessionid/csrf)
    if (res.status !== 200 && after === '') {
        await ensureAuth();
        loadCookies();
        res = await igFetch(url);
    }

    if (res.status !== 200) {
        // Check body for specific auth errors
        const body = res.body.substring(0, 200);
        if (body.includes('login') || body.includes('Please wait') || body.includes('checkpoint')) {
            console.log(`  [GRAPHQL AUTH] Instagram checkpoint/block — skipping comment fetch`);
        } else {
            console.log(`  [GRAPHQL COMMENTS ERROR] ${res.status}: ${body}`);
        }
        return { comments: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 };
    }

    try {
        const data = JSON.parse(res.body);
        const section = data.data?.shortcode_media?.edge_media_to_parent_comment;
        if (!section) return { comments: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 };

        const edges = section.edges || [];
        const pageInfo = section.page_info || {};
        const totalCount = section.count || 0;

        const comments = edges.map(e => e.node).map(c => ({
            pk: c.id,
            username: c.owner?.username || '',
            fullName: c.owner?.username || '',
            text: c.text || '',
            createdAt: c.created_at,
            likeCount: c.edge_liked_by?.count || 0,
            childCount: c.edge_threaded_comments?.count || 0,
            isVerified: c.owner?.is_verified || false,
            profilePic: c.owner?.profile_pic_url || '',
        }));

        return {
            comments,
            pageInfo: {
                hasNextPage: pageInfo.has_next_page || false,
                endCursor: pageInfo.end_cursor || null,
            },
            totalCount,
        };
    } catch (e) {
        console.log(`  [GRAPHQL PARSE ERROR] ${e.message}`);
        return { comments: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 };
    }
}

/**
 * Fetch ALL comments for a post via GraphQL pagination.
 */
async function fetchAllPostCommentsGraphQL(shortcode, maxComments = 100) {
    const allComments = [];
    let after = '';
    let page = 0;
    const maxPages = 10;

    while (page < maxPages && allComments.length < maxComments) {
        const { comments, pageInfo } = await fetchPostCommentsGraphQL(shortcode, after);
        if (comments.length === 0) break;
        allComments.push(...comments);
        if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
        after = pageInfo.endCursor;
        page++;
    }

    return allComments.slice(0, maxComments);
}

// ============== BROWSER ==============
let _browser = null;
let _context = null;
let _page = null;

function makeStealthContext() {
    return {
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false,
        ignoreHTTPSErrors: true,
    };
}

async function initBrowser() {
    if (_browser) return;

    // ensureAuth() validates/creates session and returns fresh cookies.
    // Use those directly — do NOT re-read from file (which may have stale sessionid).
    const freshCookies = await ensureAuth();
    if (freshCookies) {
        _cookies = freshCookies;
        _cookieStr = _cookies.map(c => c.name + '=' + c.value).join('; ');
        _csrftoken = _cookies.find(c => c.name === 'csrftoken')?.value || '';
        // Save fresh cookies to file so next run doesn't re-login unnecessarily
        const cookieFile = path.join(__dirname, '..', 'instagram-cookies.json');
        const fixed = _cookies.map(c => ({ ...c, sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite || 'None') }));
        fs.writeFileSync(cookieFile, JSON.stringify(fixed, null, 4));
    } else {
        loadCookies();
    }
    console.log('[BROWSER] Launching...');
    _browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-proxy-client-cert-request',
            '--disable-features=DnsOverHttpsPinger',
        ]
    });

    _context = await _browser.newContext(makeStealthContext());

    // Apply sameSite fix for Playwright
    const fixedCookies = _cookies.map(c => ({
        ...c,
        sameSite: c.sameSite === 'no_restriction' ? 'None' : c.sameSite
    }));

    await _context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5], configurable: true });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
        window.chrome = { runtime: {} };
    });

    await _context.addCookies(fixedCookies);
    _page = await _context.newPage();

    // Establish session
    await _page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await safeWait(2000);
    // Capture all cookies (including Instagram-set ones) so HTTP API calls work
    await refreshCookieStr();
    console.log('[BROWSER] Session ready, URL:', _page.url().substring(0, 50));
}

// Refresh HTTP client cookie string from current browser context
// Called after browser visits Instagram — captures all cookies including
// Instagram-set ones (ig_did, ig_nrcb, datr, mid, etc.) that are needed
// for API calls to return 200 instead of 302.
async function refreshCookieStr() {
    if (!_context) return;
    // IMPORTANT: never overwrite user's original sessionid — browser's stealth browser
    // creates its own session which may have different expiration date, causing
    // session validity check to fail on next run → infinite login loop.
    const existing = _cookies || [];
    const existingSessionId = existing.find(c => c.name === 'sessionid');
    const browserCookies = await _context.cookies('https://www.instagram.com');

    // Keep existing sessionid, add any missing browser-set cookies
    const merged = [...existing];
    for (const bc of browserCookies) {
        if (bc.name === 'sessionid') continue; // never overwrite user's sessionid
        const idx = merged.findIndex(c => c.name === bc.name);
        if (idx >= 0) {
            merged[idx] = bc;
        } else {
            merged.push(bc);
        }
    }
    _cookies = merged;
    _cookieStr = _cookies.map(c => c.name + '=' + c.value).join('; ');
    _csrftoken = _cookies.find(c => c.name === 'csrftoken')?.value || '';
}

async function closeBrowser() {
    if (_browser) {
        await _browser.close();
        _browser = null;
        _context = null;
        _page = null;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============== POST ENRICHMENT (oEmbed - fast, no auth) ==============
// oEmbed is public, returns username + caption + hashtags in ~30ms per post
// Can run 50+ concurrent requests for ~2000 posts/min
function oEmbedFetch(url) {
    return new Promise((resolve) => {
        const req = https.get({
            hostname: 'i.instagram.com',
            path: '/api/v1/oembed/?url=' + encodeURIComponent(url),
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
                'Accept': 'application/json, */*',
            },
            timeout: 8000,
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    const title = j.title || '';
                    const hashtags = [...title.matchAll(/#(\w+)/g)].map(m => m[1].toLowerCase());
                    const caption = title;
                    // author_name format: "Display Name" or just "username"
                    const username = j.author_name || '';
                    const authorUrl = j.author_url || '';
                    // Extract username from author_url: https://www.instagram.com/username/
                    const urlUsername = authorUrl.match(/instagram\.com\/([^\/]+)/)?.[1] || username;

                    resolve({
                        username: urlUsername,
                        displayName: j.author_name || '',
                        userPk: String(j.author_id || ''),
                        likes: 0,
                        comments: 0,
                        caption,
                        hashtags,
                        mentions: [],
                        collabs: [],
                        date: j.timestamp || null,
                        postUrl: url,
                        shortcode: url.split('/p/')[1]?.replace('/', '') || '',
                        mediaId: j.media_id || '',
                        _source: 'oembed',
                    });
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

/**
 * Enrich a post URL using fast oEmbed (public API, no auth needed).
 * Used for batch enrichment in Phase 1-2 where we need username from post URLs.
 * Falls back to browser scrape if oEmbed fails.
 */
async function enrichPostFromOEmbed(postUrl) {
    return oEmbedFetch(postUrl);
}

/**
 * Batch oEmbed enrichment - parallel, no rate limiting, ~2000 posts/min
 */
async function enrichPostsOEmbed(urls) {
    const results = await Promise.all(urls.map(url => oEmbedFetch(url)));
    return results.filter(Boolean);
}

// ============== POST ENRICHMENT (API) — with batch concurrency ==============
async function enrichPostFromApi(postUrl) {
    // Extract shortcode
    const shortcode = postUrl.split('/p/')[1]?.replace('/', '') || '';
    if (!shortcode) return null;

    const mediaId = decodeShortcode(shortcode);
    // No per-request sleep — batch controller handles rate limiting
    const res = await igFetch(`https://i.instagram.com/api/v1/media/${mediaId}/info/`);
    if (res.status !== 200) {
        console.log(`  [API ERROR] ${shortcode}: ${res.status}`);
        return null;
    }

    try {
        const data = JSON.parse(res.body);
        const item = data.items?.[0];
        if (!item) return null;

        const caption = item.caption?.text || '';
        const hashtags = (caption.match(/#\w+/g) || []).map(h => h.toLowerCase());
        const mentions = (caption.match(/@([a-zA-Z0-9._]+)/g) || [])
            .map(m => m.slice(1).toLowerCase());

        // Collabs from tagged users
        const collabs = (item.usertags?.in || [])
            .map(t => t.user?.username)
            .filter(Boolean);

        // Remove author from mentions
        const authorUsername = item.user?.username?.toLowerCase() || '';
        const filteredMentions = mentions.filter(m => m !== authorUsername);

        return {
            username: item.user?.username || '',
            displayName: item.user?.full_name || '',
            userPk: item.user?.pk || '',
            likes: item.like_count || 0,
            comments: item.comment_count || 0,
            caption,
            hashtags,
            mentions: filteredMentions,
            collabs,
            date: new Date(item.taken_at * 1000).toISOString(),
            postUrl: `https://www.instagram.com/p/${shortcode}/`,
            shortcode,
            mediaId,
        };
    } catch (e) {
        console.log(`  [API PARSE ERROR] ${shortcode}: ${e.message}`);
        return null;
    }
}

// ============== POST ENRICHMENT (Playwright HTML) — fallback when API 302 ==============
/**
 * Extract post data directly from HTML page via Playwright.
 * Uses the browser session (which is still valid), bypassing the Mobile API.
 */
async function enrichPostFromBrowser(postUrl) {
    if (!_page) await initBrowser();

    const shortcode = postUrl.split('/p/')[1]?.replace('/', '') || '';
    if (!shortcode) return null;

    // Reset to about:blank first — Instagram anti-bot detects direct search→post navigation
    // Then wait before going to post page
    await _page.goto('about:blank').catch(() => {});
    await sleep(3000);

    // Navigate with retry
    try {
        await _page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {
        if (e.message?.includes('ERR_ABORTED') || e.message?.includes('net::ERR')) {
            // Reset state
            await _page.goto('about:blank').catch(() => {});
            await sleep(2000);
            try {
                await _page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            } catch {
                console.log(`  [BROWSER WARN] Failed to load: ${shortcode}`);
                return null;
            }
        } else {
            return null;
        }
    }
    await safeWait(3000);

    const bodyLen = await _page.evaluate(() => document.body.innerHTML.length);
    if (bodyLen < 200) {
        console.log(`  [BROWSER WARN] Empty page: ${shortcode}`);
        return null;
    }

    // Extract from __NEXT_DATA__ JSON (same technique as todshop/radjatopup)
    const nextDataRaw = await _page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        return el ? el.textContent : null;
    });

    let username = '', displayName = '', fullText = '', likes = 0, comments = 0, hashtags = [], mentions = [], takenAt = null;

    if (nextDataRaw) {
        try {
            const nd = JSON.parse(nextDataRaw);
            // Walk the GraphQL shortcode_media path
            const media = nd.props?.pageProps?.data?.shortcode_media
                || nd.props?.pageProps?.graphql?.shortcode_media;
            if (media) {
                username = media.user?.username || '';
                displayName = media.user?.full_name || '';
                fullText = media.edge_media_to_caption?.edges?.[0]?.node?.text || '';
                likes = media.edge_media_preview_like?.count
                    || media.edge_liked_by?.count
                    || media.likes?.count || 0;
                comments = media.edge_media_to_parent_comment?.count
                    || media.comments?.count || 0;
                takenAt = media.taken_at_timestamp || null;

                // Hashtags + mentions from caption
                hashtags = (fullText.match(/#\w+/g) || []).map(h => h.toLowerCase());
                mentions = (fullText.match(/@([a-zA-Z0-9._]+)/g) || [])
                    .map(m => m.slice(1).toLowerCase());

                // Tagged users (collabs)
                const tagged = media.edge_media_to_tagged_user?.edges || [];
                const collabs = tagged.map(t => t.node?.user?.username).filter(Boolean);

                const authorUsername = username.toLowerCase();
                const filteredMentions = mentions.filter(m => m !== authorUsername);

                return {
                    username,
                    displayName,
                    userPk: media.user?.id || '',
                    likes,
                    comments,
                    caption: fullText,
                    hashtags,
                    mentions: filteredMentions,
                    collabs,
                    date: takenAt ? new Date(takenAt * 1000).toISOString() : null,
                    postUrl,
                    shortcode,
                    mediaId: '',
                };
            }
        } catch (e) {
            // Fall through to body parse
        }
    }

    // Fallback: extract from meta tags and body text
    const ogTitle = await _page.evaluate(() => document.querySelector('meta[property="og:title"]')?.content || '');
    const ogDesc = await _page.evaluate(() => document.querySelector('meta[property="og:description"]')?.content || '');
    const ogImage = await _page.evaluate(() => document.querySelector('meta[property="og:image"]')?.content || '');

    // og:title format: "DisplayName(@username) on Instagram: \"caption text\""
    // og:description format: "123 likes, 45 comments - username on Jan 1, 2026: \"caption\""
    // → extract username from og:description (most reliable): "username on DATE" before the dash
    const descUserMatch = ogDesc.match(/-\s+([a-zA-Z0-9._]+)\s+on\s+/);
    username = descUserMatch ? descUserMatch[1] : username;

    // Extract likes/comments from og:description: "153 likes, 13 comments - ..."
    const likesMatch = ogDesc.match(/([\d,.]+)\s*(like|komentar|comment)/i);
    if (likesMatch) likes = parseInt(likesMatch[1].replace(/,/g, ''));
    const commentsMatch = ogDesc.match(/([\d,.]+)\s*(komentar|comment)/i);
    if (commentsMatch) comments = parseInt(commentsMatch[1].replace(/,/g, ''));

    // Try og:title as backup for username: "Name(@username) on Instagram"
    if (!username) {
        const titleUserMatch = ogTitle.match(/@([a-zA-Z0-9._]+)/);
        username = titleUserMatch ? titleUserMatch[1] : username;
    }

    // Extract caption from og:description: "..." (quoted text at end)
    const captionMatch = ogDesc.match(/\"([^\"]{0,500})\"$/);
    if (captionMatch) fullText = captionMatch[1];

    // Also extract hashtags from og:title and og:desc
    const allText = ogTitle + ' ' + ogDesc;
    hashtags = (allText.match(/#\w+/g) || []).map(h => h.toLowerCase());
    mentions = (allText.match(/@([a-zA-Z0-9._]+)/g) || [])
        .map(m => m.slice(1).toLowerCase());

    // Extract from body text
    const bodyText = await _page.evaluate(() => {
        const el = document.querySelector('script[type="application/ld+json"]');
        return el ? el.textContent : '';
    });

    if (bodyText) {
        try {
            const ld = JSON.parse(bodyText);
            fullText = ld.articleBody || ld.caption || '';
            hashtags = (fullText.match(/#\w+/g) || []).map(h => h.toLowerCase());
            mentions = (fullText.match(/@([a-zA-Z0-9._]+)/g) || [])
                .map(m => m.slice(1).toLowerCase());
        } catch (e) { /* ignore */ }
    }

    return {
        username,
        displayName,
        userPk: '',
        likes,
        comments,
        caption: fullText,
        hashtags,
        mentions,
        collabs: [],
        date: null,
        postUrl,
        shortcode,
        mediaId: '',
    };
}

/**
 * Enrich a post URL: oEmbed (fast) → browser fallback (for oEmbed miss).
 * Mobile API is skipped — it returns 302 (blocked) and accumulates rate limit
 * which cascades to GraphQL comment extraction. oEmbed covers 80% instantly.
 *
 * @param {string} postUrl
 * @param {boolean} skipBrowser - skip browser fallback (use for batch mode where speed matters)
 */
async function enrichPost(postUrl, skipBrowser = false) {
    // Try oEmbed first — public API, ~30ms, works for all public posts
    const oembedResult = await enrichPostFromOEmbed(postUrl);
    if (oembedResult?.username) return oembedResult;

    // Browser fallback: extracts username from og:description meta tag
    if (skipBrowser) return null;
    const browserResult = await enrichPostFromBrowser(postUrl);
    if (browserResult && browserResult.username) return browserResult;

    return null;
}

/**
 * Enrich multiple posts in parallel using fast oEmbed (no auth, ~2000 posts/min).
 * Skips slow browser fallback — use enrichPost() for full data with browser.
 */
async function enrichPostsBatch(urls) {
    const CONCURRENCY = 50;
    const all = [];
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
        const batch = urls.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(url => enrichPost(url, true)));
        all.push(...batchResults);
    }
    return all.filter(Boolean);
}

// ============== TIMEOUT WRAPPER
async function withTimeout(promise, ms, label = 'operation') {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`[TIMEOUT] ${label} exceeded ${ms}ms`)), ms);
        promise.then(v => { clearTimeout(timer); resolve(v); })
                .catch(e => { clearTimeout(timer); reject(e); });
    });
}

// ============== PROFILE ENRICHMENT
async function enrichProfileFromPage(username) {
    if (!_page) await initBrowser();
    await sleep(REQUEST_DELAY * 1000);

    const profileUrl = `https://www.instagram.com/${username}/`;

    try {
        await withTimeout(
            _page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
            40000,
            `navigate @${username}`
        );
    } catch (e) {
        console.log(`  [PROFILE TIMEOUT] @${username} — ${e.message}`);
        return buildFallbackProfile(username);
    }

    // Use safeEvaluate to handle dead page gracefully
    const safeEvaluate = async (fn) => {
        try {
            return await _page.evaluate(fn);
        } catch (e) {
            if (e.message.includes('closed') || e.message.includes('Target') || e.message.includes('Execution context')) {
                return null;
            }
            throw e;
        }
    };

    await safeWait(3000);

    const bodyLen = await safeEvaluate(() => document.body.innerHTML.length);
    if (bodyLen === null || bodyLen < 100) {
        console.log(`  [PROFILE WARN] Page closed or empty for @${username}`);
        return buildFallbackProfile(username);
    }

    // OG meta tags
    const ogTitle = await safeEvaluate(() => document.querySelector('meta[property="og:title"]')?.content || '');
    const ogDesc = await safeEvaluate(() => document.querySelector('meta[property="og:description"]')?.content || '');
    const ogImage = await safeEvaluate(() => document.querySelector('meta[property="og:image"]')?.content || '');

    // Parse og:description: "X Followers, Y Following, Z Posts"
    let followers = 0, following = 0, posts = 0;
    const ffpMatch = ogDesc.match(/([\d,]+)\s*Followers?,\s*([\d,]+)\s*Following?,\s*([\d,]+)\s*Posts?/);
    if (ffpMatch) {
        followers = parseInt(ffpMatch[1].replace(/,/g, ''));
        following = parseInt(ffpMatch[2].replace(/,/g, ''));
        posts = parseInt(ffpMatch[3].replace(/,/g, ''));
    }

    // Parse og:title: "Display Name (@username)"
    let displayName = ogTitle;
    const atIdx = ogTitle.indexOf('(@');
    if (atIdx > 0) displayName = ogTitle.substring(0, atIdx).trim();

    // Extract native location from JSON-LD schema
    let nativeLocation = '';
    try {
        const ldRaw = await safeEvaluate(() => {
            const el = document.querySelector('script[type="application/ld+json"]');
            return el ? el.textContent.trim() : '';
        });
        if (ldRaw) {
            const ld = JSON.parse(ldRaw);
            nativeLocation = ld.address?.addressLocality || ld.address?.addressRegion || '';
        }
    } catch { /* ignore */ }

    // Body text for bio, category, WA link
    const bodyText = await safeEvaluate(() => document.body.innerText || '') || '';
    const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

    let bio = '';
    let category = '';
    let waLink = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Bio starts after follower/following/posts block
        if (line.match(/Followers?|Following|Post|Verified/i)) continue;
        if (line === username) continue;
        if (line.match(/Follow|Message|Edit Profile|Similar/i)) continue;
        if (line.match(/Meta|About|Blog|Jobs|Help|API|Privacy/i)) break;

        // Collect bio lines
        if (bio === '' && line.length > 5) {
            bio = line;
        } else if (bio !== '' && line.length > 2 && line.length < 300) {
            bio += ' ' + line;
        }
    }

    // Detect category (usually after display name)
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i].toLowerCase();
        if (l.match(/makeup artist|hairstylist|mua|fotografer|catering|dekorasi|organizer/i)) {
            category = lines[i];
            break;
        }
    }

    // WA link
    const waMatch = bodyText.match(/(wa\.me\/[\d]+|whatsapp\.com\/[\w]+\/[\d]+|\+62[\d\s-]+)/i);
    if (waMatch) waLink = waMatch[0];

    // Website from link-in-bio
    let website = '';
    try {
        const websiteEl = await safeEvaluate(() => {
            // Direct link-in-bio section (new Instagram layout)
            const linkSection = document.querySelector('section a[href*="linktr.ee"], section a[href*="beacons.ai"], section a[href*="carrd.co"], section a[href*="linkbio"], section a[href*="biolink"], section a[href*="lnk.to"], section a[href*="solo.to"]');
            if (linkSection) return linkSection.getAttribute('href') || '';

            // Footer link-in-bio div
            const footerLink = document.querySelector('a[href*="linktr.ee"], a[href*="beacons.ai"], a[href*="carrd.co"], a[href*="linkbio"], a[href*="biolink"], a[href*="lnk.to"], a[href*="solo.to"], a[href*="taplink"], a[href*="linkstack"]');
            if (footerLink) return footerLink.getAttribute('href') || '';

            // Generic "website" link in bio section
            const siteLinks = document.querySelectorAll('a[href^="http"]');
            for (const el of siteLinks) {
                const href = el.getAttribute('href') || '';
                const text = (el.textContent || '').toLowerCase();
                // Skip Instagram/TikTok/mail links
                if (/instagram\.com|tiktok\.com|mailto:|facebook\.com|twitter\.com|x\.com/.test(href)) continue;
                // Include linktree-like or actual websites
                if (href.includes('linktr.ee') || href.includes('beacons.') || href.includes('carrd.') ||
                    href.includes('linkbio') || href.includes('biolink') || href.includes('lnk.to') ||
                    href.includes('solo.to') || href.includes('taplink') || href.includes('linkstack') ||
                    href.includes('link.me') || href.includes('about.me') || href.includes('link in bio')) {
                    return href;
                }
                // Accept any external URL in the bio link section (not just known platforms)
                if (href.startsWith('http') && !href.includes('instagram.com') && text.length > 2 && text.length < 60) {
                    return href;
                }
            }
            return '';
        });
        if (websiteEl) website = websiteEl;
    } catch { /* ignore */ }

    return {
        username,
        displayName,
        bio,
        category,
        nativeLocation,
        followers,
        following,
        posts,
        profileUrl: `https://www.instagram.com/${username}/`,
        ogImage,
        waLink,
        website,
    };
}

// ============== PROFILE POST SCRAPING (Playwright scroll) ==============
async function scrapeProfilePosts(username, maxPosts = 20) {
    if (!_page) await initBrowser();
    await sleep(REQUEST_DELAY * 1000);

    const profileUrl = `https://www.instagram.com/${username}/`;
    await _page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await safeWait(2000);

    // Scroll to load posts
    let prevCount = 0;
    let scrollCount = 0;
    const maxScrolls = 15;

    while (scrollCount < maxScrolls) {
        const urls = await _page.$$eval('a[href*="/p/"]',
            els => [...new Set(els.map(e => e.href))]);
        const currentCount = urls.length;

        if (currentCount > maxPosts) break;
        if (currentCount === prevCount && scrollCount > 3) break;

        prevCount = currentCount;
        await _page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await safeWait(1500);
        scrollCount++;
    }

    const allUrls = await _page.$$eval('a[href*="/p/"]',
        els => [...new Set(els.map(e => e.href))]);
    return allUrls.slice(0, maxPosts);
}

function buildFallbackProfile(username) {
    return {
        username,
        displayName: username,
        bio: '',
        category: '',
        nativeLocation: '',
        followers: 0,
        following: 0,
        posts: 0,
        profileUrl: `https://www.instagram.com/${username}/`,
        ogImage: '',
        waLink: '',
    };
}

// ============== SCRAPE HASHTAG ==============
/**
 * Scrape hashtag page via Playwright + DOM extraction.
 * Uses /explore/tags/ page + scroll for maximum post yield.
 */
async function scrapeHashtag(hashtag, maxPosts = 200) {
    if (!_page) await initBrowser();

    console.log(`[HASHTAG] ${hashtag}`);
    const cleanTag = hashtag.replace(/^#/, '');
    const searchUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(cleanTag)}/`;

    await withTimeout(
        _page.goto(searchUrl, { waitUntil: 'domcontentloaded' }),
        50000,
        `hashtag #${cleanTag}`
    );

    // Wait for posts to render
    try {
        await withTimeout(
            _page.waitForSelector('a[href*="/p/"] img', {}),
            25000,
            'wait posts selector'
        );
    } catch (e) {
        console.log(`  [WARN] No posts appeared — page may be blocked`);
    }
    await safeWait(3000);

    // Wrap entire scroll loop with 3-minute timeout
    let postUrls = [];
    try {
        postUrls = await withTimeout((async () => {
            // Scroll to load more posts
            let prevCount = 0;
            let consecutiveEmpty = 0;
            let scrollCount = 0;
            let selector = 'article a[href*="/p/"]'; // try article-first
            const maxScrolls = MAX_SCROLL_HASHTAG || 50;

            while (scrollCount < maxScrolls) {
                // Try article selector first, fall back to broader selector
                let urls = await _page.$$eval(selector,
                    els => [...new Set(els.map(e => e.href.split('?')[0]))]);

                // Fallback: if article selector finds nothing, use broader selector
                if (urls.length === 0) {
                    urls = await _page.evaluate(() => {
                        const links = Array.from(document.querySelectorAll('a[href*="/p/"]'));
                        return [...new Set(links.map(l => l.href.split('?')[0]))];
                    });
                }

                const currentCount = urls.length;

                // Stop after 8 consecutive scrolls with no new posts (truly exhausted)
                if (currentCount > 0 && currentCount === prevCount) {
                    consecutiveEmpty++;
                    if (consecutiveEmpty >= 8) {
                        console.log(`  [SCROLL] No new posts for 8 scrolls — stopping at ${currentCount}`);
                        break;
                    }
                } else {
                    consecutiveEmpty = 0;
                }

                // Stop if stuck at 0 posts for too long
                if (currentCount === 0 && scrollCount > 10) {
                    console.log(`  [SCROLL] 0 posts after ${scrollCount} scrolls — stopping`);
                    break;
                }

                prevCount = currentCount;
                // Scroll to bottom — triggers lazy loading on hashtag page
                await _page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await safeWait(2000);

                // Wait for new images to load after scroll
                try {
                    await _page.waitForSelector('a[href*="/p/"] img', { timeout: 8000 });
                } catch (_) { /* no new images, continue scrolling */ }

                scrollCount++;
            }

            // Extract final post URLs — try article first, then broader
            let postUrls = await _page.$$eval('article a[href*="/p/"]',
                els => [...new Set(els.map(e => e.href.split('?')[0]))]);
            if (postUrls.length === 0) {
                postUrls = await _page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a[href*="/p/"]'));
                    return [...new Set(links.map(l => l.href.split('?')[0]))];
                });
            }

            console.log(`  Found ${postUrls.length} post URLs (${scrollCount} scrolls)`);
            return postUrls;
        })(), 180000, 'scroll-loop');
    } catch (e) {
        console.log(`  [SCROLL TIMEOUT] ${e.message} — returning empty`);
        return [];
    }

    if (!postUrls || postUrls.length === 0) return [];

    // Enrich all post URLs with oEmbed (parallel, ~2000 posts/min, public API)
    console.log(`  Enriching ${postUrls.length} posts via oEmbed...`);
    const enriched = await enrichPostsBatch(postUrls.slice(0, maxPosts));
    console.log(`  Enriched ${enriched.length}/${postUrls.length} posts`);

    if (enriched.length > 0) {
        console.log(`  Sample: ${enriched[0]?.username || 'none'}`);
        return enriched;
    }

    // Fallback: extract from img[alt] (hashtags/mentions, no username)
    const postsData = await _page.evaluate(() => {
        const results = [];
        // Try article first, fall back to all post links
        let postLinks = Array.from(document.querySelectorAll('article a[href*="/p/"]'));
        if (postLinks.length === 0) {
            postLinks = Array.from(document.querySelectorAll('a[href*="/p/"]'));
        }
        const seenCodes = new Set();

        for (const link of postLinks) {
            const href = link.getAttribute('href');
            if (!href) continue;
            const match = href.match(/\/p\/([A-Za-z0-9_-]+)/);
            if (!match) continue;
            const code = match[1];
            if (seenCodes.has(code)) continue;
            seenCodes.add(code);

            // Get img alt text inside this post link
            const img = link.querySelector('img');
            const altText = img ? (img.getAttribute('alt') || '') : '';

            // First @mention = post author username
            const atMentions = [...altText.matchAll(/@([a-zA-Z0-9._]+)/g)].map(m => m[1]);
            const username = atMentions[0] || '';
            const otherMentions = atMentions.slice(1).map(m => m.toLowerCase());

            // Hashtags from alt text
            const hashtags = [...altText.matchAll(/#(\w+)/g)]
                .map(m => m[1].toLowerCase());

            results.push({
                shortcode: code,
                username,
                caption: altText.substring(0, 500),
                hashtags,
                mentions: otherMentions,
            });
        }
        return results;
    });

    console.log(`  Extracted ${postsData.length} posts from img[alt] — sample: ${postsData[0]?.username || 'none'}`);

    return postsData.slice(0, maxPosts).map(p => ({
        username: p.username,
        displayName: '',
        userPk: '',
        likes: 0,
        comments: 0,
        caption: p.caption,
        hashtags: p.hashtags,
        mentions: p.mentions,
        collabs: [],
        date: null,
        postUrl: `https://www.instagram.com/p/${p.shortcode}/`,
        shortcode: p.shortcode,
        mediaId: '',
    }));
}

// ============== SCRAPE MULTIPLE HASHTAGS ==============
async function scrapeHashtags(hashtags) {
    await initBrowser();

    const allPosts = [];
    const seen = new Set();
    const profileLimit = (PROFILES_PER_HASHTAG !== null && PROFILES_PER_HASHTAG !== undefined)
        ? PROFILES_PER_HASHTAG
        : 999999;

    for (const hashtag of hashtags) {
        const posts = await scrapeHashtag(hashtag);
        let count = 0;
        for (const p of posts) {
            // Dedup by shortcode (most reliable), fallback to username
            const key = p.shortcode || p.username;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            allPosts.push({ ...p, sourceHashtag: hashtag });
            count++;
            if (count >= profileLimit) break;
        }
    }

    return allPosts;
}

// ============== USER FEED (for engagement calculation) ==============
/**
 * Dedicated mobile API call for fetchUserFeed.
 * Uses igFetch's internal mobile header setup directly — igFetch(url, true)
 * does NOT actually pass mobile headers, so we call igFetch + manually patch.
 */
async function fetchUserFeedMobile(url) {
    await sleep(REQUEST_DELAY * 1000);
    return new Promise((resolve) => {
        loadCookies();
        const u = new URL(url);
        const headers = {
            'User-Agent': 'Instagram 276.0.0.0.0 Android (Android/13; SDK 33; x86; Xiaomi Redmi Note 11)',
            'Cookie': _cookieStr,
            'X-CSRFToken': _csrftoken,
            'X-IG-App-ID': '1217981644879628',
            'X-IG-App-Locale': 'en_US',
            'X-IG-Device-Locale': 'en_US',
            'Accept': 'application/json, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.instagram.com/',
        };
        const opts = { hostname: u.hostname, path: u.pathname + u.search, headers };
        const req = https.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: '' }); });
        req.end();
    });
}

/**
 * Fetch a user's recent posts via Instagram REST API (mobile endpoint).
 * Returns: { items: [{ likeCount, commentCount, takenAt, shortcode, postUrl }], nextMaxId }
 * Used for accurate engagement rate calculation + last post URL.
 *
 * @param {string} username
 * @param {number} count - max posts to fetch (default 18, max ~50 with pagination)
 */
async function fetchUserFeed(username, count = 18) {
    const posts = [];
    let nextMaxId = '';

    while (posts.length < count) {
        const url = nextMaxId
            ? `https://i.instagram.com/api/v1/feed/user/${username}/username/?max_id=${nextMaxId}&count=18`
            : `https://i.instagram.com/api/v1/feed/user/${username}/username/?count=18`;

        const res = await fetchUserFeedMobile(url);
        if (res.status !== 200) break;

        try {
            const data = JSON.parse(res.body);
            const items = data.items || [];
            if (items.length === 0) break;
            posts.push(...items.map(item => {
                const shortcode = item.code || '';
                return {
                    likeCount: item.like_count || 0,
                    commentCount: item.comment_count || 0,
                    takenAt: item.taken_at || 0,
                    shortcode,
                    postUrl: shortcode ? `https://www.instagram.com/p/${shortcode}/` : '',
                };
            }));
            nextMaxId = data.next_max_id || '';
            if (!nextMaxId) break;
        } catch (e) {
            break;
        }
    }

    return posts.slice(0, count);
}

// ============== EXPORTS ==============
export {
    initBrowser,
    closeBrowser,
    refreshCookieStr,
    enrichPostFromApi,
    enrichPost,
    enrichPostsBatch,
    enrichProfileFromPage,
    scrapeProfilePosts,
    scrapeHashtag,
    scrapeHashtags,
    decodeShortcode,
    fetchAllPostCommentsGraphQL,
    fetchPostCommentsGraphQL,
    fetchUserFeed,
};
