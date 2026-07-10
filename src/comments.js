/**
 * Instagram Prospector - Comment Extraction + Client Discovery
 *
 * Comment data via GraphQL (confirmed working 2026-07):
 * GET https://www.instagram.com/graphql/query/?query_hash=bc3296d1ce80a24b1b6e40b1e72903f5
 *
 * Client discovery strategy:
 * 1. For each post → fetch ALL comments via GraphQL
 * 2. Filter non-MUA commenters (exclude post author + other MUA accounts)
 * 3. Score by engagement quality
 * 4. Top scorers → saved to Client sheet
 */

import { fetchAllPostCommentsGraphQL, enrichPost } from './scraper.js';
import { REQUEST_DELAY } from './config.js';

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============== CLIENT SCORING ==============
const CLIENT_KEYWORDS = [
    'booking', 'book', 'pemesanan', 'reservasi', 'appointment',
    'harga', 'price', 'tarif', 'berapa', 'cost',
    'available', 'tersedia', 'jadwal', 'schedule',
    'konsultasi', 'consultation', 'tanya', 'tanya-tanya',
    ' DM ', ' dm ', ' dm!', ' dm?', ' DM!', ' DM?',
    ' WA ', ' wa ', ' whatsapp ', ' WhatsApp ',
    '0812', '0813', '628', '+62',
    'bridal', 'prewedding', 'engagement', 'engangement', 'resepsi',
    'pengantin', 'bride', 'groom', 'rias pengantin',
];

const LOCATION_KEYWORDS = [
    'semarang', 'jateng', 'jawa tengah', 'solo', 'surakarta',
    'jogja', 'yogyakarta', 'jogjakarta', 'klaten', 'ungaran',
    'kudus', 'pati', 'rembang', 'blora', 'kendal', 'tegal',
    'brebes', 'pekalongan', 'batang', 'demak', 'salatiga',
    'ambarawa', 'bawen', 'boe', 'boja', 'wonogiri', 'sragen',
];

const MUA_KEYWORDS = [
    'mua', 'makeup artist', 'make-up', 'rias pengantin', 'rias',
    'hairstylist', 'hairdo', 'hair do', 'muahid',
    'bridal', 'rias by', 'by mua', '@mua', '#mua',
];

const SUSPICIOUS_KEYWORDS = [
    'dropship', 'reseller', 'jual', 'beli', 'murah', 'promo',
    'diskon', 'sale', 'giveaway', 'rt', 'retweet', 'link bio',
    'follow', 'follower', 'followers',
];

// Location map: hashtag → display name
const LOCATION_MAP = {
    'muasemarang': 'Semarang', 'makeupsemarang': 'Semarang', 'semarang': 'Semarang',
    'muasolo': 'Solo', 'muajogja': 'Yogyakarta', 'muayogyakarta': 'Yogyakarta',
    'muajepara': 'Jepara', 'muakudus': 'Kudus', 'muapati': 'Pati',
    'muabatang': 'Batang', 'muategal': 'Tegal', 'muabrebes': 'Brebes',
    'muakendal': 'Kendal', 'muarembang': 'Rembang', 'muablora': 'Blora',
    'muademak': 'Demak', 'muabuwana': 'Buwana', 'muajawatengah': 'JawaTengah',
    'muajateng': 'JawaTengah', 'muaselatan': 'Semarang', 'muabarat': 'Semarang',
    'muatimur': 'Semarang', 'muajatim': 'JawaTimur', 'muasurabaya': 'Surabaya',
    'muabandung': 'Bandung', 'muajakarta': 'Jakarta',
    'muabol': 'Bol', 'muamaluku': 'Maluku', 'muasultra': 'SulawesiTenggara',
};

function extractLocation(hashtags) {
    if (!hashtags || hashtags.size === 0) return '';
    for (const tag of hashtags) {
        const clean = tag.toLowerCase().replace('#', '');
        if (LOCATION_MAP[clean]) return LOCATION_MAP[clean];
    }
    return '';
}

function scoreComment(commentText, authorUsername) {
    const text = (commentText + ' ' + authorUsername).toLowerCase();
    let score = 0;

    if (commentText.length > 3) score += 1;

    for (const kw of LOCATION_KEYWORDS) {
        if (text.includes(kw)) { score += 3; break; }
    }
    for (const kw of CLIENT_KEYWORDS) {
        if (text.includes(kw)) { score += 4; break; }
    }
    for (const kw of MUA_KEYWORDS) {
        if (text.includes(kw)) { score -= 5; break; }
    }
    for (const kw of SUSPICIOUS_KEYWORDS) {
        if (text.includes(kw)) { score -= 3; break; }
    }

    if (commentText.length > 20) score += 1;
    if (commentText.length > 50) score += 2;

    return Math.max(0, score);
}

/**
 * Filter out non-clients from comment list.
 */
function filterClients(comments, postAuthor) {
    const authorLower = (postAuthor || '').toLowerCase();
    return comments
        .filter(c => {
            const username = (c.username || '').toLowerCase();
            if (username && username === authorLower) return false;
            if (!c.text || c.text.trim().length < 2) return false;
            if (c.text.match(/^@?\w+$/) && c.text.length < 5) return false;
            if (username.match(/(mua|makeup|rias|hair|bridal|mua_|_\.mua|\.mua$)/i)) return false;
            if (username.match(/^(official|official_|studio|artisan|by_|the_|by)/i)) return false;
            return true;
        })
        .map(c => ({ ...c, score: scoreComment(c.text, c.username) }))
        .filter(c => c.score >= 2)
        .sort((a, b) => b.score - a.score);
}

// ============== GET COMMENT METRICS ==============
/**
 * Get comment summary from a post.
 */
async function getCommentMetrics(postUrl) {
    const post = await enrichPost(postUrl);
    if (!post) return null;
    return {
        username: post.username,
        postUrl: post.postUrl,
        caption: post.caption,
        hashtags: post.hashtags,
        likes: post.likes,
        comments: post.comments,
        date: post.date,
        shortcode: post.shortcode,
    };
}

/**
 * Extract potential clients from a list of posts (parallel batches).
 */
async function extractClientsFromPosts(posts, concurrency = 3, batchDelayMs = 3000) {
    const allClients = [];
    const seen = new Set();

    for (let i = 0; i < posts.length; i += concurrency) {
        const batch = posts.slice(i, i + concurrency);

        // Enrich post data + fetch comments in parallel
        const batchResults = await Promise.all(batch.map(async (post) => {
            const url = post.postUrl || post.url;
            const postData = await enrichPost(url);
            if (!postData || !postData.shortcode) return { clients: [], postData: null, totalComments: 0 };
            const allComments = await fetchAllPostCommentsGraphQL(postData.shortcode, 100);
            const clients = filterClients(allComments, postData.username);
            return { clients, postData, totalComments: allComments.length };
        }));

        for (const result of batchResults) {
            const { clients, postData, totalComments } = result;
            if (clients.length > 0) {
                console.log(`  [COMMENTS] @${postData?.username}: ${totalComments} total, ${clients.length} potential clients`);
            }
            for (const client of clients) {
                const key = client.username.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                allClients.push({
                    username: client.username,
                    text: client.text,
                    source: `@${postData?.username || 'unknown'}`,
                    via: 'comment',
                    hashtags: postData?.hashtags || new Set(),
                    location: extractLocation(postData?.hashtags),
                });
            }
        }

        if (i + concurrency < posts.length) {
            await sleep(batchDelayMs);
        }
    }

    return allClients.sort((a, b) => b.clientScore - a.clientScore);
}

// ============== EXPORTS ==============
export { getCommentMetrics, extractClientsFromPosts, filterClients, scoreComment };
