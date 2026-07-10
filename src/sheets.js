/**
 * Instagram Prospector - Google Sheets Integration
 *
 * Single "Instagram" sheet. Auto-creates sheet + header if not found.
 * Header check: reads row 1, if not matching expected headers, overwrites with correct ones.
 */

import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SHEETS_ID } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Expected header columns A-L
const SHEET_HEADER = [
    'No',       // A: ROW()-1 formula
    'Nama',     // B: Display Name
    'Instagram',// C: Profile URL
    'Whatsapp', // D: WhatsApp number
    'Website',  // E: Website URL
    'Category', // F: Business category
    'Followers',// G: Follower count
    'Post',     // H: Post count
    'Location', // I: Business location
    'Last Post',// J: URL of last post
    'Analytics',// K: Engagement rate
    'Status',   // L: Manual user input
];

// Number of columns
const NUM_COLS = SHEET_HEADER.length; // 12
const END_COL = 'L';

// ===== INIT =====
let sheetsClient = null;
let sheetInitialized = false;

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

        await ensureInstagramSheet();
        sheetInitialized = true;
        console.log('[SHEETS] Connected — "Instagram" sheet ready');
    } catch (e) {
        console.warn(`[SHEETS] Auth error: ${e.message} — dry-run mode`);
        sheetsClient = null;
    }

    return sheetsClient;
}

// Ensure "Instagram" sheet exists, check/fix header row
async function ensureInstagramSheet() {
    // Try to create sheet if missing
    try {
        const meta = await sheetsClient.spreadsheets.get({
            spreadsheetId: SHEETS_ID,
            fields: 'sheets.properties(sheetId,name)'
        });
        const existing = meta.data.sheets || [];
        const igSheet = existing.find(s => s.properties.name === 'Instagram');

        if (!igSheet) {
            await sheetsClient.spreadsheets.batchUpdate({
                spreadsheetId: SHEETS_ID,
                resource: {
                    requests: [{ addSheet: { properties: { title: 'Instagram', index: 0 } } }]
                }
            });
            console.log('[SHEETS] Created "Instagram" sheet');
        }
    } catch (e) {
        if (e.message?.includes('404') || e.message?.includes('not found')) {
            console.warn('[SHEETS] Spreadsheet not found — check GOOGLE_SHEETS_ID');
            sheetsClient = null;
        }
        console.warn(`[SHEETS] Sheet check: ${e.message}`);
    }

    // Check row 1 header
    try {
        const res = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SHEETS_ID,
            range: `Instagram!A1:${END_COL}1`
        });
        const existingHeader = res.data.values?.[0] || [];

        const needsHeader = existingHeader.length === 0 ||
            !existingHeader[0]?.toLowerCase().startsWith('no') ||
            existingHeader.length < NUM_COLS;

        if (needsHeader) {
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SHEETS_ID,
                range: `Instagram!A1:${END_COL}1`,
                valueInputOption: 'RAW',
                resource: { values: [SHEET_HEADER] }
            });
            console.log('[SHEETS] Header row written: No | Nama | Instagram | Whatsapp | Website | Category | Followers | Post | Location | Last Post | Analytics | Status');
        } else {
            console.log('[SHEETS] Header row OK');
        }
    } catch (e) {
        console.warn(`[SHEETS] Header check error: ${e.message}`);
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

// Read visited usernames (column C = Instagram URL)
async function readVisitedProfiles() {
    const visited = new Set();
    const rows = await readRange(`Instagram!C2:C5000`);
    for (const row of rows) {
        if (row[0]) {
            const url = row[0];
            // Extract username from URL like https://www.instagram.com/username/
            const match = url.match(/instagram\.com\/([^\/]+)/i);
            if (match) visited.add(match[1].toLowerCase());
        }
    }
    console.log(`[SHEETS] Loaded ${visited.size} visited profiles`);
    return visited;
}

// Read hashtags from column A (rows 2+) — values starting with #
async function readHashtags() {
    const rows = await readRange(`Instagram!A2:A2000`);
    const hashtags = [];
    for (const row of rows) {
        if (row[0] && row[0].startsWith('#')) {
            hashtags.push(row[0]);
        }
    }
    console.log(`[SHEETS] Loaded ${hashtags.length} hashtags`);
    return hashtags;
}

// ===== WRITE =====
async function writeRange(range, values) {
    if (!sheetsClient) {
        console.log(`[SHEETS DRY] ${range}:`, JSON.stringify(values).slice(0, 150));
        return false;
    }
    try {
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SHEETS_ID, range,
            valueInputOption: 'RAW', resource: { values }
        });
        return true;
    } catch (e) {
        console.log(`[SHEETS] Write error on ${range}: ${e.message}`);
        return false;
    }
}

async function appendRow(values) {
    if (!sheetsClient) {
        console.log(`[SHEETS DRY] Instagram APPEND:`, JSON.stringify(values).slice(0, 200));
        return false;
    }
    try {
        const res = await sheetsClient.spreadsheets.values.append({
            spreadsheetId: SHEETS_ID,
            range: `Instagram!A:${END_COL}`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            resource: { values }
        });
        return res.data?.updates?.updatedRows > 0;
    } catch (e) {
        console.log(`[SHEETS] Append error: ${e.message}`);
        return false;
    }
}

// Extract WhatsApp number from bio text
function extractWhatsApp(bio = '') {
    const patterns = [
        /(\+62[\s\-.]?\d{2,4}[\s\-.]?\d{3,4}[\s\-.]?\d{3,4})/g,
        /(08\d{2}[\s\-.]?\d{3,4}[\s\-.]?\d{3,4})/g,
        /(wa\.me\/\+?\d+)/gi,
        /(whatsapp[:\s]+[\+\d]/gi,
        /(\+62\d{8,12})/g,
    ];
    for (const pat of patterns) {
        const m = bio.match(pat);
        if (m) {
            // Clean: remove spaces, dots, dashes
            const num = m[0].replace(/[^\d+]/g, '');
            if (num.length >= 10) return num;
        }
    }
    return '';
}

// Extract website URL from bio
function extractWebsite(bio = '') {
    const m = bio.match(/https?:\/\/[^\s]+/i);
    return m ? m[0] : '';
}

// Get engagement rate display string
function formatAnalytics(followers, likes, comments) {
    if (!followers || followers === 0) return 'N/A';
    const rate = ((likes + comments) / followers * 100).toFixed(2);
    return `${rate}% (${likes}❤ + ${comments}💬)`;
}

// Unified write — all fields match column headers
async function writeProfile(profile, existingUsernames) {
    if (!profile || !profile.username) return;

    const username = profile.username.replace('@', '').toLowerCase();
    if (existingUsernames.has(username)) {
        console.log(`  [SKIP] @${username} already saved`);
        return;
    }

    // AI-enriched fields take priority; fallback to regex extraction
    const bio = profile.bio || '';
    const wa = profile.whatsapp || extractWhatsApp(bio);
    const website = profile.website || extractWebsite(bio);

    // Analytics: use AI result if available, otherwise calculate
    let analyticsStr;
    if (profile.analytics) {
        analyticsStr = typeof profile.analytics === 'string' ? profile.analytics : `${profile.analytics}%`;
    } else if (profile.followers && profile.followers > 0) {
        const rate = (((profile.postLikes || 0) + (profile.postComments || 0)) / profile.followers * 100).toFixed(2);
        analyticsStr = `${rate}%`;
    } else {
        analyticsStr = 'N/A';
    }

    const row = [
        '',                                              // A: No
        profile.displayName || username,                 // B: Nama
        profile.profileUrl || `https://instagram.com/${username}/`, // C: Instagram
        wa,                                              // D: Whatsapp
        website,                                         // E: Website
        profile.category || '',                          // F: Category
        profile.followers || 0,                          // G: Followers
        profile.posts || 0,                              // H: Post
        profile.location || '',                          // I: Location
        profile.lastPostUrl || '',                       // J: Last Post
        analyticsStr,                                    // K: Analytics
        'Pending',                                       // L: Status
    ];

    const ok = await appendRow(row);
    if (ok) {
        existingUsernames.add(username);
        console.log(`  [SAVED] @${username} | ${profile.category || '-'} | ${wa || 'no WA'}`);
    } else {
        console.log(`  [FAIL] @${username} write failed`);
    }
}

// Client from comment
async function writeClientFromComment(clientData, existingUsernames) {
    if (!clientData || !clientData.username) return;

    const username = clientData.username.replace('@', '').toLowerCase();
    if (existingUsernames.has(username)) {
        console.log(`  [SKIP CLIENT] @${username} already saved`);
        return;
    }

    const row = [
        '',
        username,
        clientData.profileUrl || `https://instagram.com/${username}/`,
        '',          // D: Whatsapp
        '',          // E: Website
        'Client',    // F: Category
        0,           // G: Followers
        0,           // H: Post
        clientData.location || '',  // I: Location
        '',          // J: Last Post
        'N/A',       // K: Analytics
        'Pending',   // L: Status
    ];

    const ok = await appendRow(row);
    if (ok) {
        existingUsernames.add(username);
        console.log(`  [SAVED CLIENT] @${username}`);
    }
}

// Write new hashtag to column A (appends as new row)
async function writeNewHashtag(hashtag) {
    if (!sheetsClient || !hashtag) return;
    const clean = hashtag.replace(/^#/, '').trim();
    if (!clean) return;

    // Append as #hashtag in columns A-L (fill rest with empty to match row width)
    const emptyRow = Array(NUM_COLS).fill('');
    emptyRow[0] = `#${clean}`;
    const ok = await appendRow([emptyRow]);
    if (ok) console.log(`  [NEW HASHTAG] #${clean}`);
}

export {
    initSheets, readHashtags, readVisitedProfiles,
    writeProfile, writeClientFromComment, writeNewHashtag,
};
