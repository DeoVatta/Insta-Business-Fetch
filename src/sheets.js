/**
 * Instagram Prospector - Google Sheets Integration
 *
 * Two sheets:
 * - "Instagram" — profile data (A-L)
 * - "Hashtags"  — hashtag tracking (A-D)
 *
 * Auto-creates sheets + headers if not found.
 */

import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyProfilesBatch } from './ai-classifier.js';
import { SHEETS_ID } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== HEADERS =====
const IG_HEADER = [
    'No', 'Nama', 'Instagram', 'Whatsapp', 'Website',
    'Category', 'Followers', 'Post', 'Location',
    'Last Post', 'Analytics', 'Status'
];

const HT_HEADER = [
    'No', 'Hashtag', 'Found', 'Status'
];

// ===== INIT =====
let sheetsClient = null;
let sheetInitialized = false;

// Batch write buffer to avoid per-row API calls (60 writes/min limit)
let _profileBuffer = []; // stores raw profile objects for AI batch
let _flushTimer = null;
const BATCH_SIZE = 10; // flush every N profiles
const BATCH_FLUSH_MS = 30000; // or every 30s

async function initSheets() {
    if (sheetsClient && sheetInitialized) return sheetsClient;

    if (!SHEETS_ID) {
        console.warn('[SHEETS] GOOGLE_SHEETS_ID not set — dry-run mode');
        sheetsClient = null;
        return null;
    }

    console.log('[SHEETS] Initializing...');

    try {
        const credPath = path.join(__dirname, '..', 'gcp-service-account.json');
        const key = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        const auth = new GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
        const authClient = await auth.getClient();
        sheetsClient = google.sheets({ version: 'v4', auth: authClient });

        await ensureSheets();
        sheetInitialized = true;
        console.log('[SHEETS] Connected — Instagram + Hashtags sheets ready');
    } catch (e) {
        console.warn(`[SHEETS] Auth error: ${e.message} — dry-run mode`);
        sheetsClient = null;
    }

    return sheetsClient;
}

// Ensure both sheets exist and have correct headers
async function ensureSheets() {
    try {
        const meta = await sheetsClient.spreadsheets.get({
            spreadsheetId: SHEETS_ID,
            fields: 'sheets.properties(sheetId,name)'
        });
        const existing = meta.data.sheets || [];
        const sheetNames = existing.map(s => s.properties.name);

        for (const [name, header] of [['Instagram', IG_HEADER], ['Hashtags', HT_HEADER]]) {
            if (!sheetNames.includes(name)) {
                await sheetsClient.spreadsheets.batchUpdate({
                    spreadsheetId: SHEETS_ID,
                    resource: {
                        requests: [{ addSheet: { properties: { title: name, index: 0 } } }]
                    }
                });
                console.log(`[SHEETS] Created "${name}" sheet`);
            }

            // Check/fix header row
            try {
                const res = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: SHEETS_ID,
                    range: `${name}!A1:${name === 'Instagram' ? 'L' : 'D'}1`
                });
                const existingHeader = res.data.values?.[0] || [];
                const needsHeader = existingHeader.length === 0 ||
                    existingHeader[0]?.toLowerCase().startsWith('no') === false ||
                    existingHeader.length < header.length;

                if (needsHeader) {
                    await sheetsClient.spreadsheets.values.update({
                        spreadsheetId: SHEETS_ID,
                        range: `${name}!A1:${name === 'Instagram' ? 'L' : 'D'}1`,
                        valueInputOption: 'RAW',
                        resource: { values: [header] }
                    });
                    console.log(`[SHEETS] Header written: "${name}" sheet`);
                }
            } catch (e) {
                console.warn(`[SHEETS] Header check "${name}": ${e.message}`);
            }
        }
    } catch (e) {
        if (e.message?.includes('404') || e.message?.includes('not found')) {
            console.warn('[SHEETS] Spreadsheet not found — check GOOGLE_SHEETS_ID');
            sheetsClient = null;
        }
        console.warn(`[SHEETS] Sheet ensure error: ${e.message}`);
    }
}

// ===== READ =====
async function readRange(range) {
    if (!sheetsClient) return [];
    try {
        const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEETS_ID, range });
        return res.data.values || [];
    } catch (e) {
        return [];
    }
}

// Read visited usernames from Instagram sheet (column C = Instagram URL)
async function readVisitedProfiles() {
    const visited = new Set();
    const rows = await readRange('Instagram!C2:C5000');
    for (const row of rows) {
        if (row[0]) {
            const match = row[0].match(/instagram\.com\/([^\/]+)/i);
            if (match) visited.add(match[1].toLowerCase());
        }
    }
    console.log(`[SHEETS] Loaded ${visited.size} visited profiles`);
    return visited;
}

// Read approved hashtags from Hashtags sheet (column B, status != Executed)
async function readHashtags() {
    const rows = await readRange('Hashtags!A1:D2000');
    const hashtags = [];
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row[1]) continue;
        const tag = row[1].trim();
        const status = (row[3] || '').trim();
        if (tag && !['Executed'].includes(status)) {
            hashtags.push(tag.startsWith('#') ? tag : '#' + tag);
        }
    }
    console.log(`[SHEETS] Loaded ${hashtags.length} pending hashtags`);
    return hashtags;
}

// Read hashtags already in sheet (for dedup)
async function readHashtagsInSheet() {
    const rows = await readRange('Hashtags!B2:B2000');
    const seen = new Set();
    for (const row of rows) {
        if (row && row[0]) seen.add(row[0].replace(/^#/, '').toLowerCase().trim());
    }
    return seen;
}

// ===== WRITE =====
async function appendRow(sheetName, endCol, values) {
    if (!sheetsClient) {
        console.log(`[SHEETS DRY] ${sheetName} APPEND:`, JSON.stringify(values).slice(0, 200));
        return false;
    }
    try {
        const res = await sheetsClient.spreadsheets.values.append({
            spreadsheetId: SHEETS_ID,
            range: `${sheetName}!A:${endCol}`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            resource: { values }
        });
        return res.data?.updates?.updatedRows > 0;
    } catch (e) {
        console.log(`[SHEETS] Append error (${sheetName}): ${e.message}`);
        return false;
    }
}

// Flush buffered profile rows to sheets in one API call
async function flushProfileRows() {
    if (_profileBuffer.length === 0) return 0;
    const profiles = _profileBuffer.splice(0, _profileBuffer.length);

    // AI batch classify all profiles at once
    let aiProfiles = profiles;
    try {
        aiProfiles = await classifyProfilesBatch(profiles);
    } catch (e) {
        console.warn(`[SHEETS BATCH] AI classify failed: ${e.message} — using raw profiles`);
    }

    // Convert to rows
    const rows = aiProfiles.map(profileToRow);
    const ok = await appendRow('Instagram', 'L', rows);
    if (ok) {
        console.log(`  [SHEETS BATCH] Flushed ${rows.length} profiles to Instagram sheet`);
    } else {
        // Put back on failure
        _profileBuffer.unshift(...profiles);
        console.log(`  [SHEETS BATCH] Flush failed — ${profiles.length} rows returned to buffer`);
    }
    return ok ? rows.length : 0;
}

// Convert a profile object to a sheet row (columns A-L)
function profileToRow(profile) {
    const bio = profile.bio || '';
    const wa = profile.whatsapp || extractWhatsApp(bio);
    const website = profile.website || extractWebsite(bio);

    let analyticsStr;
    if (profile.engagementRate !== undefined && profile.engagementRate !== null) {
        analyticsStr = `${profile.engagementRate}%`;
    } else if (profile.analytics) {
        analyticsStr = typeof profile.analytics === 'string' ? profile.analytics : `${profile.analytics}%`;
    } else if (profile.followers && profile.followers > 0) {
        const rate = (((profile.postLikes || 0) + (profile.postComments || 0)) / profile.followers * 100).toFixed(2);
        analyticsStr = `${rate}%`;
    } else {
        analyticsStr = 'N/A';
    }

    const username = (profile.username || '').replace('@', '').toLowerCase();

    // Handle clientData (from writeClientFromComment) vs full profile
    if (profile.via === 'comment') {
        return [
            '',
            username,
            profile.profileUrl || `https://instagram.com/${username}/`,
            '',
            '',
            'Client',
            0, 0,
            profile.location || '',
            '',
            'N/A',
            'Pending',
        ];
    }

    return [
        '',
        profile.displayName || username,
        profile.profileUrl || `https://instagram.com/${username}/`,
        wa,
        website,
        profile.category || '',
        profile.followers || 0,
        profile.posts || 0,
        profile.location || '',
        profile.lastPostUrl || '',
        analyticsStr,
        'Pending',
    ];
}

// Schedule flush: flush if buffer >= BATCH_SIZE, otherwise schedule timer
function scheduleFlush() {
    if (_profileBuffer.length >= BATCH_SIZE) {
        flushProfileRows();
    } else if (!_flushTimer) {
        _flushTimer = setTimeout(async () => {
            _flushTimer = null;
            await flushProfileRows();
        }, BATCH_FLUSH_MS);
    }
}

// Write a batch of AI-approved hashtags to Hashtags sheet
// Discovered hashtags → Status: Pending (queued for next run)
async function writeHashtagBatch(hashtags, existingHashtags) {
    // hashtags: [{ tag: '#muasemarang', found: 5 }, ...]
    // Status: Pending = will be processed in next run
    let written = 0;
    for (const { tag, found } of hashtags) {
        const clean = tag.replace(/^#/, '').toLowerCase().trim();
        if (!clean || existingHashtags.has(clean)) continue;
        existingHashtags.add(clean);
        // 4 values: A=ROW()-1, B=hashtag, C=found, D=Pending
        const ok = await appendRow('Hashtags', 'D', [['=ROW()-1', `#${clean}`, found, 'Pending']]);
        if (ok) written++;
    }
    console.log(`[SHEETS] ${written}/${hashtags.length} hashtags written to Hashtags sheet`);
    return written;
}

// Mark a hashtag as Executing or Executed
async function markHashtagStatus(hashtag, status) {
    if (!sheetsClient || !hashtag) return;
    const clean = hashtag.replace(/^#/, '').toLowerCase().trim();
    const rows = await readRange('Hashtags!B1:D2000');
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row && row[0] && row[0].replace(/^#/, '').toLowerCase().trim() === clean) {
            const sheetRow = i + 1;
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SHEETS_ID,
                range: `Hashtags!D${sheetRow}:D${sheetRow}`,
                valueInputOption: 'RAW',
                resource: { values: [[status]] }
            });
            console.log(`[SHEETS] Hashtag #${clean} → ${status}`);
            break;
        }
    }
}

// Read ALL hashtags with their status (including Executed)
async function readHashtagsWithStatus() {
    const rows = await readRange('Hashtags!A1:D2000');
    const hashtags = [];
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row[1]) continue;
        const tag = row[1].trim();
        const found = row[2] ? parseInt(row[2]) : 0;
        const status = (row[3] || '').trim();
        if (tag) {
            hashtags.push({ tag: tag.startsWith('#') ? tag : '#' + tag, found, status });
        }
    }
    return hashtags;
}

// Reset all Executed hashtags back to Pending (for infinite loop re-scan)
async function resetHashtagStatuses() {
    if (!sheetsClient) { console.log('[SHEETS] No client — skip reset'); return; }
    const rows = await readRange('Hashtags!A1:D2000');
    console.log(`[SHEETS] Reset: found ${rows.length} rows in Hashtags sheet`);
    const updates = [];
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row && row[3] && row[3] !== 'Pending') {
            updates.push({ rowIndex: i + 1, hashtag: row[1] });
        }
    }
    console.log(`[SHEETS] Reset: ${updates.length} non-Pending hashtags found to reset`);
    if (updates.length === 0) return;

    // Batch update all statuses to Pending
    for (const { rowIndex, hashtag } of updates) {
        try {
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SHEETS_ID,
                range: `Hashtags!D${rowIndex}:D${rowIndex}`,
                valueInputOption: 'RAW',
                resource: { values: [['Pending']] }
            });
            console.log(`[SHEETS] Reset: ${hashtag} → Pending`);
        } catch (e) {
            console.log(`[SHEETS] Reset error for ${hashtag}: ${e.message}`);
        }
    }
    console.log(`[SHEETS] Reset ${updates.length} hashtags to Pending`);
}

// Extract WhatsApp from bio
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

// Extract website from bio
function extractWebsite(bio = '') {
    const m = bio.match(/https?:\/\/[^\s]+/i);
    return m ? m[0] : '';
}

// Write a single profile to Instagram sheet (buffered — flushed every BATCH_SIZE rows or 30s)
// Stores raw profile objects; AI classify happens during flush
async function writeProfile(profile, existingUsernames) {
    if (!profile || !profile.username) return;

    const username = profile.username.replace('@', '').toLowerCase();
    if (existingUsernames.has(username)) {
        console.log(`  [SKIP] @${username} already saved`);
        return;
    }

    _profileBuffer.push(profile);
    existingUsernames.add(username);
    scheduleFlush();
    console.log(`  [BUFFER] @${username} | ${profile.category || 'N/A'} (${_profileBuffer.length} buffered)`);
}

// Write a client found via comment
async function writeClientFromComment(clientData, existingUsernames) {
    if (!clientData || !clientData.username) return;

    const username = clientData.username.replace('@', '').toLowerCase();
    if (existingUsernames.has(username)) return;

    _profileBuffer.push(clientData);
    existingUsernames.add(username);
    scheduleFlush();
    console.log(`  [BUFFER CLIENT] @${username}`);
}

export {
    initSheets, readHashtags, readHashtagsWithStatus, readHashtagsInSheet, readVisitedProfiles,
    writeHashtagBatch, markHashtagStatus, resetHashtagStatuses,
    writeProfile, writeClientFromComment, flushProfileRows,
};
