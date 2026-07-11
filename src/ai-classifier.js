/**
 * Instagram Prospector - AI Classifier
 *
 * Batch AI classification via Olagon Gateway (Claude Haiku).
 * Max 150 profiles per request. No thinking block — outputs plain JSON.
 *
 * Pipeline:
 * 1. Collect enriched profiles (up to 150)
 * 2. Send to AI in one batch request
 * 3. Parse response → merge into profiles
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
                    // Rate limited — retry with backoff
                    if (retries < MAX_RETRIES) {
                        const delay = BASE_DELAY_MS * Math.pow(2, retries);
                        console.log(`  [AI] Rate limited — retrying in ${delay / 1000}s...`);
                        setTimeout(() => {
                            resolve(aiRequest(messages, systemPrompt, maxTokens, retries + 1));
                        }, delay);
                    } else {
                        reject(new Error('Rate limited after 3 retries'));
                    }
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`AI request failed: ${res.statusCode} — ${body.slice(0, 200)}`));
                    return;
                }
                try {
                    const json = JSON.parse(body);
                    const text = extractText(json);
                    resolve(text);
                } catch (e) {
                    reject(new Error(`AI parse error: ${e.message} — body: ${body.slice(0, 300)}`));
                }
            });
        });
        req.on('error', e => {
            if (retries < MAX_RETRIES) {
                const delay = BASE_DELAY_MS * Math.pow(2, retries);
                setTimeout(() => resolve(aiRequest(messages, systemPrompt, maxTokens, retries + 1)), delay);
            } else {
                reject(e);
            }
        });
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('AI request timeout')); });
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
const SYSTEM_PROMPT = `You are a data extraction assistant for Indonesian wedding/business profiles.

Extract information from the profile data below. Return a JSON array ONLY — no thinking, no explanation, no markdown, no text outside the JSON.

Each entry in output:
{"u":"username","c":"category","l":"location","w":"whatsapp","e":"website","eng":"engagement_rate_percent","note":"1-line-summary"}

Rules:
- c (category): Business type ONLY — MUA, Fotografer, Videografer, Catering, Dekorasi, Venue, Gaun/Kebaya, Wedding Planner, Salon/Beauty, MC, Religious Services, Souvenir, Undangan, or Other. NEVER output "Client" — that is account type, not business category.
- l (location): ONLY city name in Indonesian (e.g. "Semarang", "Yogyakarta", "Solo"). NOT province. NOT country. If unclear, use the city indicated in username/bio.
- w (whatsapp): Extract phone number from bio. Format: 08xx... or +62... with no spaces/dashes. Empty string if not found.
- e (website): Extract website URL from bio. Empty string if not found.
- eng: Calculate engagement rate as: (likes + comments) / followers * 100. If followers unknown, use 0. Format: "X.XX%". If followers is 0 or unknown, return "N/A".
- note: One sentence about this business in Indonesian (max 100 chars).
- Match output username (u) exactly as input.`;

const USER_PROMPT_PREFIX = 'Process this batch:\n';

function parseAiResponse(text, profileCount) {
    const stripped = stripMarkdown(text);
    try {
        return JSON.parse(stripped);
    } catch (e) {
        // Try to extract JSON array from text
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
 * @param {Array} profiles — enriched profile objects
 * @param {number} concurrency — not used (sequential per batch)
 * @returns {Array} — profiles with AI fields merged: category, location, whatsapp, website, analytics, aiNote
 */
export async function classifyProfilesBatch(profiles, concurrency = 1) {
    if (!profiles || profiles.length === 0) return [];
    if (!OLAGON_API_KEY) {
        console.warn('[AI] OLAGON_API_KEY not set — skipping AI classification');
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

        // Build compact input
        const input = batch.map(p => ({
            u: p.username || '',
            n: p.displayName || '',
            b: ((p.bio || '') + ' ' + (p.caption || '')).slice(0, 500),
            f: p.followers || 0,
            lks: p.postLikes || 0,
            cms: p.postComments || 0,
            h: [...(p.hashtags || [])].slice(0, 10).join(' '),
            loc: p.nativeLocation || p.location || '',
            caps: [p.caption || ''].filter(Boolean).slice(0, 3).join(' | '),
        }));

        const messages = [{ role: 'user', content: USER_PROMPT_PREFIX + JSON.stringify(input) }];

        try {
            const text = await aiRequest(messages, SYSTEM_PROMPT);
            const parsed = parseAiResponse(text, batch.length);

            // Build lookup by username
            const lookup = {};
            for (const item of parsed) {
                lookup[item.u?.toLowerCase()] = item;
            }

            for (const profile of batch) {
                const key = (profile.username || '').toLowerCase();
                const ai = lookup[key] || {};

                // AI-enhanced data
                const aiCategory = ai.c || profile.category || 'Other';
                // "Client" is account type, not business category — never use it as category
                const isClient = /^client$/i.test(aiCategory);
                const isValidCategory = aiCategory && aiCategory !== 'Other' && !isClient;
                const category = isValidCategory ? aiCategory : (profile.category || 'Other');
                const aiLocation = ai.l || profile.location || '';
                const aiWhatsApp = ai.w || extractWhatsApp(profile.bio || '');
                const aiWebsite = ai.e || extractWebsite(profile.bio || '');
                const aiEngagement = ai.eng || 'N/A';
                const aiNote = ai.note || '';

                results.push({
                    ...profile,
                    category,
                    location: aiLocation || profile.location || '',
                    whatsapp: aiWhatsApp,
                    website: aiWebsite,
                    analytics: aiEngagement,
                    aiNote,
                    aiBatch: batchNum,
                });
            }

            console.log(`[AI] Batch ${batchNum} done: ${parsed.length} results`);
        } catch (e) {
            console.warn(`[AI] Batch ${batchNum} failed: ${e.message} — using fallback data`);
            // On failure, use enriched data + regex extraction as fallback
            for (const profile of batch) {
                results.push({
                    ...profile,
                    whatsapp: extractWhatsApp(profile.bio || ''),
                    website: extractWebsite(profile.bio || ''),
                    analytics: profile.engagementRate ? `${profile.engagementRate}%` : 'N/A',
                    aiNote: 'AI unavailable — used rule-based extraction',
                    aiBatch: batchNum,
                });
            }
        }
    }

    return results;
}

// ===== HASHTAG CLASSIFICATION =====
const HT_SYSTEM_PROMPT = `You are a hashtag classifier for Indonesian wedding/bride industry.

Analyze each hashtag and determine if it is related to a business or brand.

Each hashtag has the format: #hashtag (e.g. #muasemarang, #riasjogja)

Return a JSON array ONLY — no thinking, no explanation, no markdown.

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

Be strict — only mark true if clearly a business/service hashtag.`;

// Max 200 hashtags per request
const HT_BATCH_MAX = 200;

export async function classifyHashtagsBatch(hashtags) {
    if (!hashtags || hashtags.length === 0) return [];
    if (!OLAGON_API_KEY) {
        console.warn('[AI] OLAGON_API_KEY not set — skipping hashtag classification');
        return hashtags.map(t => ({ tag: t, business: true, reason: 'no AI key' }));
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
            console.warn(`[AI] Hashtag batch ${batchNum} failed: ${e.message} — marking all as business`);
            for (const t of batch) {
                allResults.push({ tag: '#' + t, business: true, reason: 'AI unavailable' });
            }
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
