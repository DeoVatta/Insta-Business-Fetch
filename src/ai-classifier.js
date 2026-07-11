/**
 * Instagram Prospector - AI Classifier
 *
 * Batch AI classification via Olagon Gateway (Claude Haiku).
 * Max 150 profiles per request. No thinking block -- outputs plain JSON.
 *
 * Pipeline:
 * 1. Collect enriched profiles (up to 150)
 * 2. Send to AI in one batch request
 * 3. Parse response -- merge into profiles
 * 4. Write to Sheets
 */

import https from 'https';
import { OLAGON_API_KEY, OLAGON_BASE_URL } from './config.js';

const MODEL = 'claude-haiku-4-20250514';
const BATCH_MAX = 150;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 5000;

// ===== HTTP CLIENT =====
function aiRequest(messages, systemPrompt, maxTokens = 8192, retries = 0) {
    return new Promise((resolve, reject) => {
        const reqBody = {
            model: MODEL,
            max_tokens: maxTokens,
            messages: [
                ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                ...messages
            ]
        };
        const data = JSON.stringify(reqBody);

        const baseUrl = OLAGON_BASE_URL || 'https://gateway.olagon.site';
        const url = new URL(`${baseUrl}/anthropic/v1/messages`);

        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OLAGON_API_KEY}`,
                'Content-Length': Buffer.byteLength(data),
                'anthropic-version': '2023-06-01'
            }
        };

        const req = https.request(options, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                if (res.statusCode === 429) {
                    if (retries < MAX_RETRIES) {
                        const delay = BASE_DELAY_MS * Math.pow(2, retries);
                        console.log(`  [AI] Rate limited (${res.statusCode}) -- retry ${retries + 1}/${MAX_RETRIES} in ${delay / 1000}s...`);
                        setTimeout(() => {
                            resolve(aiRequest(messages, systemPrompt, maxTokens, retries + 1));
                        }, delay);
                    } else {
                        reject(new Error(`Rate limited after ${MAX_RETRIES} retries -- will retry with longer delay`));
                    }
                    return;
                }
                if (res.statusCode !== 200) {
                    if (retries < MAX_RETRIES) {
                        const delay = BASE_DELAY_MS * Math.pow(2, retries);
                        console.log(`  [AI] Non-200 (${res.statusCode}) -- retry ${retries + 1}/${MAX_RETRIES} in ${delay / 1000}s...`);
                        setTimeout(() => {
                            resolve(aiRequest(messages, systemPrompt, maxTokens, retries + 1));
                        }, delay);
                    } else {
                        reject(new Error(`AI request failed: ${res.statusCode} -- ${body.slice(0, 200)}`));
                    }
                    return;
                }
                try {
                    const json = JSON.parse(body);
                    const text = extractText(json);
                    resolve(text);
                } catch (e) {
                    if (retries < MAX_RETRIES) {
                        const delay = BASE_DELAY_MS * Math.pow(2, retries);
                        console.log(`  [AI] Parse error -- retry ${retries + 1}/${MAX_RETRIES} in ${delay / 1000}s...`);
                        setTimeout(() => {
                            resolve(aiRequest(messages, systemPrompt, maxTokens, retries + 1));
                        }, delay);
                    } else {
                        reject(new Error(`AI parse error: ${e.message} -- body: ${body.slice(0, 300)}`));
                    }
                }
            });
        });
        req.on('error', e => {
            if (retries < MAX_RETRIES) {
                const delay = BASE_DELAY_MS * Math.pow(2, retries);
                console.log(`  [AI] Network error -- retry ${retries + 1}/${MAX_RETRIES} in ${delay / 1000}s...`);
                setTimeout(() => resolve(aiRequest(messages, systemPrompt, maxTokens, retries + 1)), delay);
            } else {
                reject(e);
            }
        });
        req.setTimeout(120000, () => {
            req.destroy();
            if (retries < MAX_RETRIES) {
                const delay = BASE_DELAY_MS * Math.pow(2, retries);
                console.log(`  [AI] Request timeout -- retry ${retries + 1}/${MAX_RETRIES} in ${delay / 1000}s...`);
                setTimeout(() => {
                    resolve(aiRequest(messages, systemPrompt, maxTokens, retries + 1));
                }, delay);
            } else {
                reject(new Error('AI request timeout'));
            }
        });
        req.write(data);
        req.end();
    });
}

// Extract text from response content block
function extractText(json) {
    const content = json.content || [];
    for (const block of content) {
        if (block.type === 'text') return block.text || '';
    }
    return '';
}

// Strip markdown code blocks
function stripMarkdown(text) {
    return text
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

// Extract WhatsApp number from bio
function extractWhatsApp(bio = '') {
    const patterns = [
        /(?:wa(?:\.me|[\s:]*)|whatsapp[\s:]*)([\+\d][\d\s\-]{8,})/i,
        /(\+62[\s\-.]?\d{2,4}[\s\-.]?\d{3,4}[\s\-.]?\d{3,4})/,
        /(0[89]\d[\s\-.]?\d{3,4}[\s\-.]?\d{3,4})/,
    ];
    for (const pat of patterns) {
        const m = bio.match(pat);
        if (m) {
            const num = m[1].replace(/[^\d+]/g, '');
            if (num.length >= 10) return num;
        }
    }
    return '';
}

// Extract website URL from bio
function extractWebsite(bio = '') {
    const m = bio.match(/https?:\/\/[^\s,]+/i);
    return m ? m[0] : '';
}

// ===== BATCH CLASSIFY =====
const SYSTEM_PROMPT = `You are a data extraction assistant for Indonesian business Instagram profiles.

Analyze the profile data and extract business information. Return a JSON array ONLY -- no thinking, no explanation, no markdown, no text outside the JSON.

Each entry:
{"u":"username","c":"category","l":"location","w":"whatsapp","e":"website","eng":"engagement_rate_percent","i":true_or_false,"note":"1-line-summary"}

Rules:
- u: Match exactly as input username.
- c (category): SPECIFIC business category based on bio, display name, captions, and hashtags. Examples:
  * "Akuntansi / Pajak" -- akuntan, konsultan pajak, pembukuan, SPT
  * "Consulting / Konsultan" -- bisnis konsultan umum, manajemen, legal
  * "Fashion / Clothing" -- apparel, distro, sneakers, shoes, tas
  * "Fashion Muslimah" -- hijab, mukena, gamis, busana muslim
  * "Makanan & Minuman" -- F&B, kuliner, warung, cafe, restaurant, catering food
  * "Minuman" -- kopi, teh, jus, minuman bottled/粉末
  * "Kecantikan" -- skincare, kosmetik, parfum, beauty products
  * "Kesehatan / Suplemen" -- obat, suplemen, vitamin, produk kesehatan
  * "Elektronik / Gadget" -- HP, laptop, komputer, aksesoris elektronik
  * "Pendidikan / Kursus" -- les, bimbingan belajar, kursus, sekolah
  * "Fotografi / Videografi" -- fotografer, videografer, editor
  * "Dekorasi / Event" -- dekorasi, organizer event, MC
  * "Properti / Interior" -- property agent, interior design, furniture
  * "Travel / Tourism" -- travel agent, tour, homestay, hotel
  * "Otomotif" -- bengkel, spare part, modifikasi kendaraan
  * "Pets / Hewan" -- pet shop, grooming, klinik hewan
  * "Pertanian" -- bibit, pupuk, alat pertanian
  * "Online Shop" -- general e-commerce, reseller, dropshipper
  * "Jasa / Layanan" -- ONLY if truly generic/unknown. Try to be specific first.
  Use Indonesian. Be SPECIFIC. NEVER default to "Jasa / Layanan" or "Other".
- l (location): City name in Indonesian (Jakarta, Semarang, Yogyakarta, Surabaya, Bandung). NOT province/country. Infer from username/bio or empty string.
- w (whatsapp): Phone from bio. Format: 08xx... or +62... no spaces. Empty if not found.
- e (website): URL from bio. Empty if not found.
- eng: (likes + comments) / followers * 100. Format: "X.XX%". "N/A" if followers unknown or 0.
- i (isIndonesian): TRUE if the profile/content appears to be Indonesian. Consider: bio language (Indonesian words: yang, dan, di, dengan, untuk, ini, itu, ada, etc.), location in Indonesia, Indonesian currency mentions (RP, rupiah), +62 phone, city names. FALSE if clearly foreign (English-only bio, foreign location, no Indonesian indicators).
- note: 1 sentence about this business in Indonesian describing what they sell/offer (max 100 chars).

Return ALL profiles in the batch. Do NOT skip any.`;

const USER_PROMPT_PREFIX = 'Extract from this batch:\n';

function normaliseCategory(cat) {
    if (!cat) return '';
    return String(cat).trim();
}

function parseAiResponse(text, profileCount) {
    const stripped = stripMarkdown(text);
    try {
        return JSON.parse(stripped);
    } catch (e) {
        const startIdx = stripped.indexOf('[');
        const endIdx = stripped.lastIndexOf(']');
        if (startIdx !== -1 && endIdx !== -1) {
            try {
                return JSON.parse(stripped.slice(startIdx, endIdx + 1));
            } catch (e2) {
                throw new Error(`JSON parse failed: ${e.message}. Text: ${stripped.slice(0, 200)}`);
            }
        }
        throw new Error(`No JSON array in response: ${stripped.slice(0, 200)}`);
    }
}

/**
 * Classify a batch of profiles via AI.
 * AI output includes isIndonesian flag -- non-Indonesian profiles are skipped by sheets.js.
 */
export async function classifyProfilesBatch(profiles, concurrency = 1) {
    if (!profiles || profiles.length === 0) return [];
    if (!OLAGON_API_KEY) {
        console.warn('[AI] OLAGON_API_KEY not set -- skipping AI classification');
        return profiles;
    }

    const batches = [];
    for (let i = 0; i < profiles.length; i += BATCH_MAX) {
        batches.push(profiles.slice(i, i + BATCH_MAX));
    }

    console.log(`[AI] Processing ${profiles.length} profiles in ${batches.length} batch(es) (max ${BATCH_MAX}/request)`);

    const results = [];

    for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const batchNum = b + 1;

        console.log(`[AI] Batch ${batchNum}/${batches.length}: ${batch.length} profiles...`);

        // Build AI input -- include ALL captions from feedPosts for full context
        const input = batch.map(p => {
            const feedCaps = (p.feedPosts || [])
                .filter(fp => fp.postUrl)
                .slice(0, 6)
                .map(fp => fp.postUrl);
            const allCaps = [p.caption || ''].concat(feedCaps).filter(Boolean).join(' || ');
            return {
                u: p.username || '',
                n: p.displayName || '',
                b: ((p.bio || '') + ' ' + (p.caption || '')).slice(0, 600),
                f: p.followers || 0,
                lks: p.postLikes || 0,
                cms: p.postComments || 0,
                h: [...(p.hashtags || [])].slice(0, 15).join(' '),
                loc: p.nativeLocation || p.location || '',
                caps: allCaps.slice(0, 400),
            };
        });

        const messages = [{ role: 'user', content: USER_PROMPT_PREFIX + JSON.stringify(input) }];

        try {
            const text = await aiRequest(messages, SYSTEM_PROMPT);
            const parsed = parseAiResponse(text, batch.length);

            if (parsed && parsed.length > 0) {
                const first = parsed[0];
                console.log(`  [AI DEBUG] @${first.u} --> category="${first.c}", location="${first.l}", wa="${first.w}", eng="${first.eng}", indonesian=${first.i}`);
            }

            const lookup = {};
            for (const item of parsed) {
                lookup[item.u?.toLowerCase()] = item;
            }

            for (const profile of batch) {
                const key = (profile.username || '').toLowerCase();
                const ai = lookup[key] || {};

                const rawAiCategory = ai.c || '';
                const finalCategory = normaliseCategory(rawAiCategory) || 'Unknown';
                const aiLocation = ai.l || profile.location || '';
                const aiWhatsApp = ai.w || extractWhatsApp(profile.bio || '');
                const aiWebsite = ai.e || extractWebsite(profile.bio || '');
                const aiEngagement = ai.eng || 'N/A';
                const aiNote = ai.note || '';
                const isIndonesian = ai.i === true;

                results.push({
                    ...profile,
                    category: finalCategory,
                    location: aiLocation || profile.location || '',
                    whatsapp: aiWhatsApp,
                    website: aiWebsite,
                    analytics: aiEngagement,
                    aiNote,
                    aiBatch: batchNum,
                    isIndonesian,
                });
            }

            console.log(`[AI] Batch ${batchNum} done: ${parsed.length} results`);
        } catch (e) {
            console.warn(`[AI] Batch ${batchNum} failed: ${e.message} -- retrying...`);
            await new Promise(r => setTimeout(r, 30000));
            b--;
            continue;
        }
    }

    return results;
}

// ===== HASHTAG CLASSIFICATION =====
const HT_SYSTEM_PROMPT = `You are a hashtag classifier for Indonesian wedding/bride industry.

Analyze each hashtag and determine if it is related to a business or brand.

Each hashtag has the format: #hashtag (e.g. #muasemarang, #riasjogja)

Return a JSON array ONLY -- no thinking, no explanation, no markdown.

Each entry:
{"h":"hashtag_name_without_#","business":true_or_false,"reason":"short reason in Indonesian"}

business=true if:
- Related to wedding/makeup/beauty vendors (MUA, fotografer, dekorasi, catering, gaun, venue, organizer, MC, dll)
- Business/service type hashtags
- Location-based vendor hashtags (e.g. #muasemarang = business)
- Brand or service account hashtags

business=false if:
- Generic/lifestyle hashtags (love, happy, beautiful, nature, dll)
- General Instagram hashtags with no business relation
- Personal/use hashtags unrelated to wedding services
- Event-only hashtags without vendor relation

Be strict -- only mark true if clearly a business/service hashtag.`;

// Max 200 hashtags per request
const HT_BATCH_MAX = 200;

export async function classifyHashtagsBatch(hashtags) {
    if (!hashtags || hashtags.length === 0) return [];
    if (!OLAGON_API_KEY) {
        console.warn('[AI] OLAGON_API_KEY not set -- hashtag classification skipped, pipeline will retry');
        throw new Error('OLAGON_API_KEY not configured');
    }

    const unique = [...new Set(hashtags.map(t => t.replace(/^#/, '').toLowerCase().trim()))].filter(Boolean);
    if (unique.length === 0) return [];

    const batches = [];
    for (let i = 0; i < unique.length; i += HT_BATCH_MAX) {
        batches.push(unique.slice(i, i + HT_BATCH_MAX));
    }

    console.log(`[AI] Classifying ${unique.length} hashtags in ${batches.length} batch(es)`);

    const allResults = [];

    for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const batchNum = b + 1;
        console.log(`[AI] Hashtag batch ${batchNum}/${batches.length}: ${batch.length} hashtags...`);

        const messages = [{
            role: 'user',
            content: JSON.stringify(batch.map(t => '#' + t)) + '\n\nJSON array only. No thinking. No markdown.'
        }];

        try {
            const text = await aiRequest(messages, HT_SYSTEM_PROMPT);
            const parsed = parseAiResponse(text, batch.length);

            for (const item of parsed) {
                const tag = item.h?.startsWith('#') ? item.h : '#' + (item.h || '');
                allResults.push({
                    tag,
                    business: item.business === true || item.business === 'true',
                    reason: item.reason || '',
                });
            }

            console.log(`[AI] Hashtag batch ${batchNum}: ${parsed.length} results`);
        } catch (e) {
            console.warn(`[AI] Hashtag batch ${batchNum} failed: ${e.message}`);
            throw e;
        }
    }

    const businessOnly = allResults.filter(r => r.business);
    console.log(`[AI] ${businessOnly.length}/${allResults.length} hashtags classified as business-related`);

    return businessOnly;
}

export async function classifyProfileQuick(profile) {
    if (!OLAGON_API_KEY) return profile;
    const profiles = await classifyProfilesBatch([profile]);
    return profiles[0] || profile;
}
