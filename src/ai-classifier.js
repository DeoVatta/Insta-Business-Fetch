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

// Strip markdown code blocks + normalize newlines (AI sometimes splits JSON objects)
function stripMarkdown(text) {
    return text
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .replace(/\n+/g, ' ')  // collapse newlines — AI splits JSON objects across lines
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
const SYSTEM_PROMPT = `You are a data extraction assistant for Indonesian WEDDING & GRADUATION (wisuda) business Instagram profiles.

Analyze the profile data and extract business information. Return a JSON array ONLY -- no thinking, no explanation, no markdown, no text outside the JSON.

Each entry:
{"u":"username","c":"category","l":"location","w":"whatsapp","e":"website","eng":"engagement_rate_percent","i":true_or_false,"note":"1-line-summary"}

Rules:
- u: Match exactly as input username.
- c (category): SPECIFIC wedding/graduation business category based on bio, display name, captions, and hashtags. Examples:
  Wedding services:
  * "MUA / Rias" -- makeup artist, rias pengantin, bridal makeup, hairstylist
  * "Photographer" -- fotografer, videografer, wedding photo, prewedding
  * "Catering" -- catering, katering, nasi box, wedding cake, tumpeng
  * "Decorator" -- dekorasi, dekorator, dekor, decoration, styling
  * "Venue / Gedung" -- venue, ballroom, hotel, resort pengantin
  * "Wedding Organizer" -- WO, event organizer, EO, wedding planner, wedding coordinator
  * "Gaun / Kebaya" -- gaun pengantin, kebaya, dress, gown, boutique
  * "Undangan" -- undangan, invitation, kartu nikah, wedding invitation
  * "MC / Celebran" -- MC pernikahan, celebrant, officiant
  * "Souvenir / Seserahan" -- souvenir, seserahan, gift, bouquet, bantal couple
  * "Music / Entertainment" -- DJ pernikahan, band, sound system, musik pengantin
  * "Car / Transport" -- mobil pengantin, wedding car, transportasi
  * "Salon / Beauty" -- salon, nails, lashes, beauty bridal
  * "Khotmil / Pengajian" -- ustadz, khotmil, pengajian,penceramah
  Graduation services:
  * "Wisuda Photographer" -- fotografer wisuda, sesi foto wisuda, graduation photographer
  * "Toga / Graduation" -- sewa toga, graduation gear, wisuda accessories
  If account is NOT a wedding/graduation business (e.g., personal wedding account, generic shop, fashion unrelated to wedding), return isIndonesian=false.
  NEVER default to generic categories like "Jasa / Layanan". Be specific.
- l (location): City name in Indonesian (Jakarta, Semarang, Yogyakarta, Surabaya, Bandung). NOT province/country. Infer from username/bio or empty string.
- w (whatsapp): Phone from bio. Format: 08xx... or +62... no spaces. Empty if not found.
- e (website): URL from bio. Empty if not found.
- eng: (likes + comments) / followers * 100. Format: "X.XX%". "N/A" if followers unknown or 0.
- i (isIndonesian): TRUE if the profile appears to be Indonesian. Consider: bio language (Indonesian words: yang, dan, di, dengan, untuk, ini, dll), location in Indonesia, Indonesian currency (RP, rupiah), +62 phone, city names. FALSE if clearly foreign (English-only bio, foreign location, no Indonesian indicators).
  IMPORTANT: Also return FALSE if the account is a personal account (someone posting their own wedding/graduation photos) rather than a business account.
- note: 1 sentence about this business in Indonesian describing what they sell/offer (max 100 chars).

Return ALL profiles in the batch. Do NOT skip any.`;

const USER_PROMPT_PREFIX = 'Extract from this batch:\n';

function normaliseCategory(cat) {
    if (!cat) return '';
    return String(cat).trim();
}

// Parse JSON array from AI response — handles multiple formats:
// 1. Standard JSON array: [{...}, {...}]
// 2. AI wrote each object on its own line (no commas between objects)
// 3. Truncated/stripped — tries to recover partial objects
function parseAiResponse(text, profileCount) {
    const stripped = stripMarkdown(text);
    // Format 1: standard array
    try {
        return JSON.parse(stripped);
    } catch (_) {}

    // Format 2: objects on separate lines — detect and normalize
    const lines = stripped.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
    if (lines.length >= 2) {
        // Try wrapping in [ ] and joining with commas
        const normalized = '[' + lines.map(l => {
            // Ensure each object ends with } before adding comma
            const trimmed = l.endsWith(',') ? l.slice(0, -1) : l;
            return trimmed;
        }).join(',') + ']';
        try {
            return JSON.parse(normalized);
        } catch (_) {
            // Fallback: try parsing each line individually
            const results = [];
            for (const line of lines) {
                const trimmed = line.endsWith(',') ? line.slice(0, -1) : line;
                try { results.push(JSON.parse(trimmed)); } catch (_) {}
            }
            if (results.length > 0) return results;
        }
    }

    // Format 3: find first [ ... ] slice
    const startIdx = stripped.indexOf('[');
    const endIdx = stripped.lastIndexOf(']');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        try {
            return JSON.parse(stripped.slice(startIdx, endIdx + 1));
        } catch (e2) {
            throw new Error(`JSON parse failed: ${e2.message}. Text: ${stripped.slice(0, 300)}`);
        }
    }
    throw new Error(`No JSON array in response: ${stripped.slice(0, 200)}`);
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
const HT_SYSTEM_PROMPT = `You are a hashtag classifier for Indonesian WEDDING & GRADUATION industry ONLY.

Classify each hashtag as business=true ONLY if it is clearly related to wedding or graduation services.

business=true if:
- Wedding vendors: MUA (makeup artist), hairstylist, photographer, videografer, catering, wedding organizer (WO), event organizer (EO), decorator/dekorasi, venue/gedung pernikahan, MC, wedding planner
- Wedding products: gaun pengantin, kebaya, dress, seserahan, souvenir, invitation/undangan, bouquet, wedding cake, tumpeng
- Wedding-related: prewedding, engagement, akad, resepsi, lamaran, rias pengantin, bridal makeup
- Graduation/Wisuda: wisuda, toga, graduation, sesi foto wisuda
- Location-tagged vendor: #muasemarang, #fotografersolo, #cateringjogja (business if clearly a vendor)
- Beauty industry: makeup, skincare, lashes, nails — if context is bridal/graduation

business=false if:
- Generic/lifestyle hashtags (love, beautiful, happy, nature,风景)
- Generic fashion hashtags unrelated to wedding (#fashion, #ootd, #bajulebaran)
- Generic food hashtags unrelated to wedding catering
- Personal/general hashtags: #weddingday, #love, #couplegoals (these describe personal events, not vendor services)
- Hashtags from personal posts: anyone tagging their own wedding, graduation photos
- General event hashtags without vendor relation

Each hashtag has the format: #hashtag_name

Return a JSON array ONLY — no thinking, no explanation, no markdown.

Each entry:
{"h":"hashtag_name_without_#","business":true_or_false,"reason":"1-line reason in Indonesian"}

// Max 50 hashtags per request — keep output small enough to fit in 8192 tokens
const HT_BATCH_MAX = 50;

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
