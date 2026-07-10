/**
 * Instagram Prospector - Google Sheets Integration
 *
 * Single "Instagram" sheet for all data — no sheet splitting.
 * Auto-creates sheet if missing. Append mode (insertDataOption: INSERT_ROWS).
 */

import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SHEETS_ID } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Unified header for all scraped data
const SHEET_HEADER = [
    'No', 'Profile URL', 'Username', 'Via', 'Source Hashtag',
    'Type', 'Category', 'Display Name', 'Location',
    'Followers', 'Following', 'Posts', 'Engagement %',
    'Bio', 'Hashtags', 'Mentions', 'Collabs',
    'Comment Text', 'Date Scraped'
];

// Column count
const END_COL = 'S'; // columns A–S

// ===== INIT =====
let sheetsClient = null;
let sheetInitialized = false;

async function initSheets() {
    if (sheetsClient && sheetInitialized) return sheetsClient;

    if (!SHEETS_ID) {
        console.warn('[SHEETS] GOOGLE_SHEETS_ID not set — running in dry-run mode');
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

        // Ensure "Instagram" sheet exists
        await ensureInstagramSheet();
        sheetInitialized = true;

        console.log('[SHEETS] Connected — single "Instagram" sheet');
    } catch (e) {
        console.log(`[SHEETS] Auth error: ${e.message}`);
        console.warn('[SHEETS] Running in dry-run mode (no data will be written)');
        sheetsClient = null;
    }

    return sheetsClient;
}

// Auto-create "Instagram" sheet tab if it doesn't exist
async function ensureInstagramSheet() {
    try {
        // Try to read existing sheet list
        const meta = await sheetsClient.spreadsheets.get({
            spreadsheetId: SHEETS_ID,
            fields: 'sheets.properties(sheetId,name)'
        });
        const existing = meta.data.sheets || [];
        const hasInstagram = existing.some(s => s.properties.name === 'Instagram');

        if (!hasInstagram) {
            // Create new sheet tab named "Instagram"
            await sheetsClient.spreadsheets.batchUpdate({
                spreadsheetId: SHEETS_ID,
                resource: {
                    requests: [{
                        addSheet: {
                            properties: { title: 'Instagram', index: 0 }
                        }
                    }]
                }
            });
            console.log('[SHEETS] Created new "Instagram" sheet');
        }
    } catch (e) {
        // If spreadsheet itself doesn't exist, create it
        if (e.message?.includes('404') || e.message?.includes('not found')) {
            console.warn('[SHEETS] Spreadsheet not found — create one and set GOOGLE_SHEETS_ID');
            sheetsClient = null;
            return;
        }
        console.log(`[SHEETS] Sheet check warning: ${e.message}`);
    }

    // Write header row to Instagram sheet (row 1)
    try {
        const existing = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SHEETS_ID,
            range: 'Instagram!A1:A1'
        });
        // Only write header if A1 is empty
        if (!existing.data.values?.[0]?.[0]) {
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SHEETS_ID,
                range: `Instagram!A1:${END_COL}1`,
                valueInputOption: 'RAW',
                resource: { values: [SHEET_HEADER] }
            });
            console.log('[SHEETS] Header row written to "Instagram" sheet');
        } else {
            console.log('[SHEETS] "Instagram" sheet already has data — appending');
        }
    } catch (e) {
        console.log(`[SHEETS] Header write error: ${e.message}`);
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

// Read hashtags from the first column of Instagram sheet (column A, rows 2+)
async function readHashtags() {
    const rows = await readRange('Instagram!A2:A2000');
    const hashtags = [];
    for (const row of rows) {
        if (row[0] && row[0].startsWith('#')) {
            hashtags.push(row[0]);
        }
    }
    console.log(`[SHEETS] Loaded ${hashtags.length} hashtags from sheet`);
    return hashtags;
}

// Read visited usernames (column C = Username)
async function readVisitedProfiles() {
    const visited = new Set();
    const rows = await readRange('Instagram!C2:C5000');
    for (const row of rows) {
        if (row[0]) visited.add(row[0].replace('@', '').trim().toLowerCase());
    }
    console.log(`[SHEETS] Loaded ${visited.size} visited profiles`);
    return visited;
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

// Append a single row to Instagram sheet
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

// Single unified write function for all profile data
async function writeProfile(profile, existingUsernames) {
    if (!profile || !profile.username) return;

    const username = profile.username.toLowerCase().replace('@', '');
    if (existingUsernames.has(username)) {
        console.log(`  [SKIP] @${username} already saved`);
        return;
    }

    const today = new Date().toISOString().split('T')[0];

    // Unified row: match SHEET_HEADER column order
    const row = [
        '',                                          // No (auto-numbered by Sheets)
        profile.profileUrl || `https://instagram.com/${username}/`,  // Profile URL
        `@${username}`,                              // Username
        profile.via || 'hashtag',                    // Via
        profile.sourceHashtag || '',                  // Source Hashtag
        profile.type || 'client',                     // Type
        profile.category || '',                       // Category
        profile.displayName || username,             // Display Name
        profile.location || '',                       // Location
        profile.followers || 0,                       // Followers
        profile.following || 0,                       // Following
        profile.posts || 0,                          // Posts
        profile.engagementRate || 'N/A',             // Engagement %
        (profile.bio || '').slice(0, 300),           // Bio
        [...(profile.hashtags || [])].join(' '),    // Hashtags
        [...(profile.mentions || [])].slice(0, 20).join(', '),  // Mentions
        [...(profile.collabs || [])].slice(0, 10).join(', '),   // Collabs
        (profile.commentText || profile.text || '').slice(0, 300), // Comment Text
        today,                                        // Date Scraped
    ];

    const ok = await appendRow(row);
    if (ok) {
        existingUsernames.add(username);
        console.log(`  [SAVED] @${username} → ${profile.type || 'client'} | ${profile.category || '-'}`);
    } else {
        console.log(`  [FAIL] @${username} write failed`);
    }
}

// Write client found via comment (convenience wrapper)
async function writeClientFromComment(clientData, existingUsernames) {
    if (!clientData || !clientData.username) return;

    const username = clientData.username.toLowerCase().replace('@', '');
    if (existingUsernames.has(username)) {
        console.log(`  [SKIP CLIENT] @${username} already saved`);
        return;
    }

    const today = new Date().toISOString().split('T')[0];

    const row = [
        '',
        clientData.profileUrl || `https://instagram.com/${username}/`,
        `@${username}`,
        clientData.via || 'comment',
        clientData.source || '',
        'client',
        'Client',
        username,
        clientData.location || '',
        0, 0, 0, 'N/A',
        '',
        '',
        '',
        '',
        (clientData.commentText || clientData.text || '').slice(0, 300),
        today,
    ];

    const ok = await appendRow(row);
    if (ok) {
        existingUsernames.add(username);
        console.log(`  [SAVED CLIENT] @${username} via ${clientData.via || 'comment'}`);
    }
}

// Write new hashtag (adds to first column as #hashtag, rows 2+)
async function writeNewHashtag(hashtag) {
    if (!sheetsClient || !hashtag) return;
    const clean = hashtag.replace(/^#/, '').trim();
    if (!clean) return;

    // Append as #hashtag in column A
    const ok = await appendRow([[`#${clean}`]]);
    if (ok) console.log(`  [NEW HASHTAG] #${clean}`);
}

export {
    initSheets, readHashtags, readVisitedProfiles,
    writeProfile, writeClientFromComment, writeNewHashtag,
};
