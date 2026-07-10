/**
 * Instagram Prospector - Phase 1: Hashtag Discovery + Post Enrichment
 *
 * Confirmed working methods:
 * 1. Playwright → /explore/search/keyword/?q=%23{hashtag} → post URLs
 * 2. oEmbed → public API → username + caption + hashtags
 * 3. Playwright → /{username}/ → profile data (bio, followers, following)
 * 4. GraphQL → /graphql/query/ → post comments
 */

import { chromium } from 'playwright';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { REQUEST_DELAY, NAVIGATE_DELAY, MAX_SCROLL_HASHTAG, POSTS_PER_HASHTAG } from './config.js';
import { ensureAuth } from './instagram-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    const cookieFile = path.join(__dirname, '..', 'instagram-cookies.json');
    _cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf-8'));
    _cookieStr = _cookies.map(c => c.name + '=' + c.value).join('; ');
    _csrftoken = _cookies.find(c => c.name === 'csrftoken')?.value || '';
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
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
            setTimeout(() => {
                const retryReq = mod.request(opts, res2 => {
                    let data2 = '';
                    res2.on('data', c => data2 += c);
                    res2.on('end', () => resolve({ status: res2.statusCode, body: data2 }));
                });
                retryReq.on('error', e2 => reject(e2));
                retryReq.setTimeout(15000);
                retryReq.end();
            }, 3000);
        });
        req.setTimeout(15000);
        req.end();
    });
}

// ============== POST COMMENTS (GraphQL) ==============
async function fetchPostCommentsGraphQL(shortcode, after = '') {
    await sleep(REQUEST_DELAY * 1000);
    const variables = JSON.stringify({ shortcode, first: 50, after });
    const url = `https://www.instagram.com/graphql/query/?query_hash=bc3296d1ce80a24b1b6e40b1e72903f5&variables=${encodeURIComponent(variables)}`;
    let res = await igFetch(url);

    if (res.status !== 200 && after === '') {
        await ensureAuth();
        loadCookies();
        res = await igFetch(url);
    }

    if (res.status !== 200) {
        const body = res.body.substring(0, 200);
        if (body.includes('login') || body.includes('Please wait') || body.includes('checkpoint')) {
            console.log(`  [GRAPHQL AUTH] Instagram checkpoint/block`);
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

        return { comments, pageInfo: { hasNextPage: pageInfo.has_next_page || false, endCursor: pageInfo.end_cursor || null }, totalCount };
    } catch (e) {
        console.log(`  [GRAPHQL PARSE ERROR] ${e.message}`);
        return { comments: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 };
    }
}

async function fetchAllPostCommentsGraphQL(shortcode, maxComments = 100) {
    const allComments = [];
    let after = '';
    let page = 0;
    while (page < 10 && allComments.length < maxComments) {
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
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false,
        ignoreHTTPSErrors: true,
    };
}

async function initBrowser() {
    if (_browser) return;

    const freshCookies = await ensureAuth();
    if (freshCookies) {
        _cookies = freshCookies;
        _cookieStr = _cookies.map(c => c.name + '=' + c.value).join('; ');
        _csrftoken = _cookies.find(c => c.name === 'csrftoken')?.value || '';
        const cookieFile = path.join(__dirname, '..', 'instagram-cookies.json');
        const fixed = _cookies.map(c => ({ ...c, sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite || 'None') }));
        fs.writeFileSync(cookieFile, JSON.stringify(fixed, null, 4));
    } else {
        loadCookies();
    }

    console.log('[BROWSER] Launching...');
    _browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    _context = await _browser.newContext(makeStealthContext());

    const fixedCookies = _cookies.map(c => ({ ...c, sameSite: c.sameSite === 'no_restriction' ? 'None' : c.sameSite }));
    await _context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5], configurable: true });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
        window.chrome = { runtime: {} };
    });
    await _context.addCookies(fixedCookies);
    _page = await _context.newPage();
    await _page.goto('https://www.instagram.com/', { waitUntil: 'networkidle', timeout: 30000 });
    await _page.waitForTimeout(2000);
    await refreshCookieStr();
    console.log('[BROWSER] Session ready:', _page.url().substring(0, 50));
}

async function refreshCookieStr() {
    if (!_context) return;
    const existing = _cookies || [];
    const existingSessionId = existing.find(c => c.name === 'sessionid');
    const browserCookies = await _context.cookies('https://www.instagram.com');
    const merged = [...existing];
    for (const bc of browserCookies) {
        if (bc.name === 'sessionid') continue;
        const idx = merged.findIndex(c => c.name === bc.name);
        if (idx >= 0) merged[idx] = bc;
        else merged.push(bc);
    }
    _cookies = merged;
    _cookieStr = _cookies.map(c => c.name + '=' + c.value).join('; ');
    _csrftoken = _cookies.find(c => c.name === 'csrftoken')?.value || '';
}

async function closeBrowser() {
    if (_browser) { await _browser.close(); _browser = null; _context = null; _page = null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============== oEmbed (PUBLIC API - no auth) ==============
function oEmbedFetch(url) {
    return new Promise(resolve => {
        const req = https.get({
            hostname: 'i.instagram.com',
            path: '/api/v1/oembed/?url=' + encodeURIComponent(url),
            headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126 Safari/537.36', 'Accept': 'application/json, */*' },
            timeout: 8000,
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    const title = j.title || '';
                    const hashtags = [...title.matchAll(/#(\w+)/g)].map(m => m[1].toLowerCase());
                    const authorUrl = j.author_url || '';
                    const urlUsername = authorUrl.match(/instagram\.com\/([^\/]+)/)?.[1] || j.author_name || '';
                    resolve({
                        username: urlUsername,
                        displayName: j.author_name || '',
                        userPk: String(j.author_id || ''),
                        likes: 0, comments: 0,
                        caption: title,
                        hashtags,
                        mentions: [],
                        collabs: [],
                        date: j.timestamp || null,
                        postUrl: url,
                        shortcode: url.split('/p/')[1]?.replace('/', '') || '',
                        mediaId: j.media_id || '',
                    });
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

async function enrichPostsBatch(urls) {
    const CONCURRENCY = 50;
    const all = [];
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
        const batch = urls.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(url => oEmbedFetch(url)));
        all.push(...batchResults);
    }
    return all.filter(Boolean);
}

// ============== POST ENRICHMENT ==============
async function enrichPost(postUrl) {
    return oEmbedFetch(postUrl);
}

// ============== PROFILE ENRICHMENT ==============
async function enrichProfileFromPage(username) {
    if (!_page) await initBrowser();
    await sleep(REQUEST_DELAY * 1000);

    const profileUrl = `https://www.instagram.com/${username}/`;
    await _page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await _page.waitForTimeout(3000);

    const bodyLen = await _page.evaluate(() => document.body.innerHTML.length);
    if (bodyLen < 100) {
        return buildFallbackProfile(username);
    }

    const ogTitle = await _page.evaluate(() => document.querySelector('meta[property="og:title"]')?.content || '');
    const ogDesc = await _page.evaluate(() => document.querySelector('meta[property="og:description"]')?.content || '');

    let followers = 0, following = 0, posts = 0;
    const ffpMatch = ogDesc.match(/([\d,]+)\s*Followers?,\s*([\d,]+)\s*Following?,\s*([\d,]+)\s*Posts?/);
    if (ffpMatch) {
        followers = parseInt(ffpMatch[1].replace(/,/g, ''));
        following = parseInt(ffpMatch[2].replace(/,/g, ''));
        posts = parseInt(ffpMatch[3].replace(/,/g, ''));
    }

    let displayName = ogTitle;
    const atIdx = ogTitle.indexOf('(@');
    if (atIdx > 0) displayName = ogTitle.substring(0, atIdx).trim();

    let nativeLocation = '';
    try {
        const ldRaw = await _page.evaluate(() => {
            const el = document.querySelector('script[type="application/ld+json"]');
            return el ? el.textContent.trim() : '';
        });
        if (ldRaw) {
            const ld = JSON.parse(ldRaw);
            nativeLocation = ld.address?.addressLocality || ld.address?.addressRegion || '';
        }
    } catch { /* ignore */ }

    const bodyText = await _page.evaluate(() => document.body.innerText || '');
    const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

    let bio = '', category = '';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.match(/Followers?|Following|Post|Verified/i)) continue;
        if (line === username) continue;
        if (line.match(/Follow|Message|Edit Profile|Similar|Meta|About|Blog|Jobs|Help|API|Privacy/i)) break;
        if (bio === '' && line.length > 5) bio = line;
        else if (bio !== '' && line.length > 2 && line.length < 300) bio += ' ' + line;
    }

    for (let i = 0; i < lines.length; i++) {
        const l = lines[i].toLowerCase();
        if (l.match(/makeup artist|hairstylist|mua|fotografer|catering|dekorasi|organizer/i)) {
            category = lines[i];
            break;
        }
    }

    return { username, displayName, bio, category, nativeLocation, followers, following, posts, profileUrl: `https://instagram.com/${username}/`, ogImage: '', waLink: '' };
}

function buildFallbackProfile(username) {
    return { username, displayName: username, bio: '', category: '', nativeLocation: '', followers: 0, following: 0, posts: 0, profileUrl: `https://instagram.com/${username}/`, ogImage: '', waLink: '' };
}

// ============== SCRAPE PROFILE POSTS ==============
async function scrapeProfilePosts(username, maxPosts = 20) {
    if (!_page) await initBrowser();
    await sleep(REQUEST_DELAY * 1000);

    await _page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await _page.waitForTimeout(2000);

    let prevCount = 0, scrollCount = 0;
    while (scrollCount < 15) {
        const urls = await _page.$$eval('a[href*="/p/"]', els => [...new Set(els.map(e => e.href))]);
        if (urls.length >= maxPosts) break;
        if (urls.length === prevCount && scrollCount > 3) break;
        prevCount = urls.length;
        await _page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await _page.waitForTimeout(1500);
        scrollCount++;
    }

    const allUrls = await _page.$$eval('a[href*="/p/"]', els => [...new Set(els.map(e => e.href))]);
    return allUrls.slice(0, maxPosts);
}

// ============== SCRAPE HASHTAG ==============
async function scrapeHashtag(hashtag, maxPosts = 200) {
    if (!_page) await initBrowser();

    console.log(`[HASHTAG] #${hashtag}`);
    await _page.goto(`https://www.instagram.com/explore/search/keyword/?q=%23${encodeURIComponent(hashtag)}`, { waitUntil: 'domcontentloaded', timeout: 40000 });

    try {
        await _page.waitForSelector('a[href*="/p/"] img', { timeout: 20000 });
    } catch { /* page may be blocked */ }
    await _page.waitForTimeout(1000);

    const postLimit = (POSTS_PER_HASHTAG !== null) ? POSTS_PER_HASHTAG : 999999;
    let prevCount = 0, scrollCount = 0;

    while (scrollCount < (MAX_SCROLL_HASHTAG || 50)) {
        const urls = await _page.$$eval('a[href*="/p/"]', els => [...new Set(els.map(e => e.href.split('?')[0]))]);
        if (urls.length >= postLimit) break;
        if (urls.length === prevCount && scrollCount > 3) break;
        prevCount = urls.length;
        await _page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        try { await _page.waitForSelector('a[href*="/p/"] img', { timeout: 8000 }); } catch { /* ignore */ }
        await _page.waitForTimeout(1000);
        scrollCount++;
    }

    const postUrls = await _page.$$eval('a[href*="/p/"]', els => [...new Set(els.map(e => e.href.split('?')[0]))]);
    console.log(`  Found ${postUrls.length} post URLs (${scrollCount} scrolls)`);
    if (postUrls.length === 0) return [];

    console.log(`  Enriching ${postUrls.length} posts via oEmbed...`);
    const enriched = await enrichPostsBatch(postUrls.slice(0, maxPosts));
    console.log(`  Enriched ${enriched.length}/${postUrls.length} posts`);
    if (enriched.length > 0) return enriched;

    // Fallback: extract from img[alt]
    const postsData = await _page.evaluate(() => {
        const results = [];
        const postLinks = Array.from(document.querySelectorAll('a[href*="/p/"]'));
        const seenCodes = new Set();
        for (const link of postLinks) {
            const href = link.getAttribute('href');
            if (!href) continue;
            const match = href.match(/\/p\/([A-Za-z0-9_-]+)/);
            if (!match || seenCodes.has(match[1])) continue;
            seenCodes.add(match[1]);
            const img = link.querySelector('img');
            const altText = img ? (img.getAttribute('alt') || '') : '';
            const atMentions = [...altText.matchAll(/@([a-zA-Z0-9._]+)/g)].map(m => m[1]);
            const hashtags = [...altText.matchAll(/#(\w+)/g)].map(m => m[1].toLowerCase());
            results.push({ shortcode: match[1], username: atMentions[0] || '', caption: altText.substring(0, 500), hashtags, mentions: atMentions.slice(1) });
        }
        return results;
    });

    console.log(`  Extracted ${postsData.length} posts from img[alt]`);
    return postsData.slice(0, maxPosts).map(p => ({
        username: p.username, displayName: '', userPk: '', likes: 0, comments: 0,
        caption: p.caption, hashtags: p.hashtags, mentions: p.mentions, collabs: [],
        date: null, postUrl: `https://www.instagram.com/p/${p.shortcode}/`, shortcode: p.shortcode, mediaId: '',
    }));
}

export {
    initBrowser, closeBrowser, refreshCookieStr,
    enrichPost, enrichPostsBatch,
    enrichProfileFromPage, scrapeProfilePosts, scrapeHashtag,
    fetchAllPostCommentsGraphQL, fetchPostCommentsGraphQL,
};
