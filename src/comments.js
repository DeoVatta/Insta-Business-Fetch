/**
 * Instagram Prospector - Comment Extraction + Client Discovery
 */

import { fetchAllPostCommentsGraphQL } from './scraper.js';
import { REQUEST_DELAY } from './config.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const CLIENT_KEYWORDS = [
    'booking', 'book', 'pemesanan', 'reservasi', 'appointment',
    'harga', 'price', 'tarif', 'berapa', 'cost',
    'available', 'tersedia', 'jadwal', 'schedule',
    'konsultasi', 'consultation', 'tanya',
    ' DM ', ' dm ', ' dm!', ' dm?', ' DM!', ' DM?',
    ' WA ', ' wa ', ' whatsapp ', ' WhatsApp ',
    '0812', '0813', '628', '+62',
    'bridal', 'prewedding', 'engagement', 'resepsi',
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

function extractLocation(hashtags) {
    if (!hashtags || hashtags.size === 0) return '';
    const LOCATION_MAP = {
        'muasemarang': 'Semarang', 'makeupsemarang': 'Semarang', 'semarang': 'Semarang',
        'muasolo': 'Solo', 'muajogja': 'Yogyakarta', 'muajepara': 'Jepara',
        'muakudus': 'Kudus', 'muapati': 'Pati', 'muabatang': 'Batang',
        'muategal': 'Tegal', 'muabrebes': 'Brebes', 'muabandung': 'Bandung',
        'muajakarta': 'Jakarta', 'muamaluku': 'Maluku',
    };
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
    for (const kw of LOCATION_KEYWORDS) { if (text.includes(kw)) { score += 3; break; } }
    for (const kw of CLIENT_KEYWORDS) { if (text.includes(kw)) { score += 4; break; } }
    for (const kw of MUA_KEYWORDS) { if (text.includes(kw)) { score -= 5; break; } }
    for (const kw of SUSPICIOUS_KEYWORDS) { if (text.includes(kw)) { score -= 3; break; } }
    if (commentText.length > 20) score += 1;
    if (commentText.length > 50) score += 2;
    return Math.max(0, score);
}

export function filterClients(comments, postAuthor) {
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

export async function extractClientsFromPosts(posts, concurrency = 3, batchDelayMs = 3000) {
    const allClients = [];
    const seen = new Set();

    for (let i = 0; i < posts.length; i += concurrency) {
        const batch = posts.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(async (post) => {
            const url = post.postUrl || post.url;
            const postData = await fetchAllPostCommentsGraphQL(url.split('/p/')[1]?.replace(/\/$/, '') || '', 100);
            const clients = filterClients(postData, post.username || '');
            return { clients, postData, totalComments: postData.length };
        }));

        for (const result of batchResults) {
            const postAuthor = result.postData?.username || '';
            if (result.clients.length > 0) {
                console.log(`  [COMMENTS] ${result.totalComments} total, ${result.clients.length} potential clients`);
            }
            for (const client of result.clients) {
                const key = client.username.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                allClients.push({
                    username: client.username,
                    text: client.text,
                    source: `@${postAuthor || 'unknown'}`,
                    via: 'comment',
                    hashtags: result.postData?.hashtags || new Set(),
                    location: extractLocation(result.postData?.hashtags),
                });
            }
        }

        if (i + concurrency < posts.length) await sleep(batchDelayMs);
    }
    return allClients;
}
