/**
 * Instagram Prospector - Google Sheets Integration
 *
 * All writes use sheetsAppend() which auto-finds the first empty row
 * via Google Sheets append API (insertDataOption: INSERT_ROWS).
 * Mutex per sheet prevents concurrent writes.
 */

import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isIndonesian } from './classifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHEETS_ID = '1xljNVmDBRHTVI7kQUCE4ALfc1Fbzue9-kiyHA0lYGwM';

const COMPETITORS_HEADER = [
    'No', 'Display Name', 'Profile URL', 'Username', 'Location', 'Region',
    'Followers', 'Following', 'Posts', 'Avg Likes', 'Engagement Rate',
    'Hashtags', 'Bio', 'Status', 'Collabs', 'Date'
];
const VENDOR_HEADER = [
    'No', 'Display Name', 'Profile URL', 'Username', 'Category', 'Location', 'Region',
    'Followers', 'Following', 'Posts', 'Avg Likes', 'Engagement Rate',
    'Hashtags', 'Bio', 'Status', 'Collabs', 'Date'
];
const HASHTAG_HEADER = ['', 'Hashtag', 'Source', 'Count', 'Date Added', 'Status', 'Status2'];
const CLIENT_HEADER = [
    'No', 'Profile URL', 'Username', 'Via', 'Source',
    'Comment Text', 'Location', 'Date Comment'
];

let sheetsClient = null;
const _locks = {};
const _seenHashtags = new Set();
const _hashtagRows = {};

function acquireLock(sheetName) {
    if (!_locks[sheetName]) _locks[sheetName] = Promise.resolve();
    const lockState = { prev: _locks[sheetName] };
    _locks[sheetName] = _locks[sheetName].then(() => {
        lockState.release = () => { _locks[sheetName] = Promise.resolve(); };
    });
    return lockState;
}

async function writeHeaders() {
    if (!sheetsClient) return;
    try {
        const existing = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SHEETS_ID, range: 'Competitors!B2:B2'
        });
        if (existing.data.values?.[0]?.[0] === 'Display Name') return;
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SHEETS_ID, range: 'Competitors!A1:P1',
            valueInputOption: 'RAW', resource: { values: [['']] }
        });
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SHEETS_ID, range: 'Competitors!A2:P2',
            valueInputOption: 'RAW', resource: { values: [COMPETITORS_HEADER] }
        });
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SHEETS_ID, range: 'Vendor!A1:Q1',
            valueInputOption: 'RAW', resource: { values: [['']] }
        });
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SHEETS_ID, range: 'Vendor!A2:Q2',
            valueInputOption: 'RAW', resource: { values: [VENDOR_HEADER] }
        });
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SHEETS_ID, range: 'Client!A1:H1',
            valueInputOption: 'RAW', resource: { values: [['']] }
        });
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SHEETS_ID, range: 'Client!A2:H2',
            valueInputOption: 'RAW', resource: { values: [CLIENT_HEADER] }
        });
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SHEETS_ID, range: 'VendorHashtags!A1:G1',
            valueInputOption: 'RAW', resource: { values: [['']] }
        });
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SHEETS_ID, range: 'VendorHashtags!A2:G2',
            valueInputOption: 'RAW', resource: { values: [HASHTAG_HEADER] }
        });
        console.log('[SHEETS] Headers written');
    } catch (e) {
        console.log(`[SHEETS] Header write error: ${e.message}`);
    }
}

async function initSheets() {
    if (sheetsClient) return sheetsClient;
    console.log('[SHEETS] Initializing...');
    try {
        const credPath = path.join(__dirname, '..', 'gcp-service-account.json');
        const key = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        const auth = new GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
        const authClient = await auth.getClient();
        sheetsClient = google.sheets({ version: 'v4', auth: authClient });
        console.log('[SHEETS] Connected (service account)');
    } catch (e) {
        console.log(`[SHEETS] Auth error: ${e.message}`);
        console.log('[SHEETS] Running in dry-run mode');
        sheetsClient = null;
    }
    await writeHeaders();
    console.log('[SHEETS] Ready (append mode)');
    return sheetsClient;
}

async function readRange(range) {
    if (!sheetsClient) return [];
    try {
        const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEETS_ID, range });
        return res.data.values || [];
    } catch (e) {
        console.log(`[SHEETS] Read error on ${range}: ${e.message}`);
        return [];
    }
}

async function readHashtags() {
    const rows = await readRange('VendorHashtags!A1:G2000');
    const hashtags = [];
    for (let i = 2; i < rows.length; i++) {
        const h = rows[i];
        if (h && h[1]) {
            const name = h[1].toLowerCase();
            _seenHashtags.add(name);
            _hashtagRows[name] = i + 1;
        }
        if (h && h[1] && (h[5] === 'OK' || h[5] === 'NEW')) {
            hashtags.push(h[1]);
        }
    }
    console.log(`[SHEETS] Loaded ${hashtags.length} hashtags (OK + NEW)`);
    return hashtags;
}

async function markHashtagExecuting(hashtag) {
    const clean = hashtag.replace(/^#/, '').toLowerCase().trim();
    const row = _hashtagRows[clean];
    if (!row) return;
    await writeRange(`VendorHashtags!G${row}:G${row}`, [['Executing']]);
}

async function markHashtagDone(hashtag, success = true) {
    const clean = hashtag.replace(/^#/, '').toLowerCase().trim();
    const row = _hashtagRows[clean];
    const now = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 16);
    const val = success ? `Executed ${now}` : `Failed ${now}`;
    if (row) await writeRange(`VendorHashtags!G${row}:G${row}`, [[val]]);
}

async function clearExecutingMarkers() {
    const rows = await readRange('VendorHashtags!A1:G2000');
    for (let i = 2; i < rows.length; i++) {
        if (rows[i][6] === 'Executing') {
            await writeRange(`VendorHashtags!G${i + 1}:G${i + 1}`, [['']]);
        }
    }
}

const _genericHashtags = new Set([
    'instagram', 'instagood', 'instadaily', 'instapic', 'instalike', 'likeforlike',
    'like4like', 'likeforlikes', 'followme', 'followforfollow', 'follow4follow',
    'fyp', 'foryou', 'foryoupage', 'viral', 'explore', 'explorepage',
    'reels', 'reelsinstagram', 'trending', 'trendingnow', 'video',
    'photooftheday', 'picoftheday', 'instamood', 'instacool', 'instafashion',
    'ootd', 'style', 'fashion', 'beautiful', 'happy', 'love',
    'cute', 'beauty', 'makeup', 'selfie', 'girl', 'women',
    'photography', 'photo', 'art', 'artist', 'nature', 'travel',
    'lifestyle', 'motivation', 'inspiration', 'goals', 'life',
    'moderne', 'baby', 'kids', 'family', 'home', 'decoration',
]);

async function writeNewHashtag(hashtag, sourceUsername) {
    if (!sheetsClient || !hashtag) return;
    const clean = hashtag.replace(/^#/, '').toLowerCase().trim();
    if (!clean || _seenHashtags.has(clean) || _genericHashtags.has(clean)) return;
    await acquireLock('VendorHashtags').prev;
    const lockState = {};
    _locks.VendorHashtags = _locks.VendorHashtags.then(() => {
        lockState.release = () => { _locks.VendorHashtags = Promise.resolve(); };
    });
    try {
        if (_seenHashtags.has(clean)) return;
        const today = new Date().toISOString().split('T')[0];
        const ok = await sheetsAppend('VendorHashtags', 'F', [[clean, `@${sourceUsername}`, '1', today, 'NEW']]);
        if (ok) { _seenHashtags.add(clean); console.log(`  [NEW HASHTAG] #${clean} from @${sourceUsername}`); }
        else { console.log(`  [SKIP HASHTAG] #${clean} write failed`); }
    } finally { if (lockState.release) lockState.release(); }
}

async function readVisitedProfiles() {
    const visited = new Set();
    for (const range of ['Competitors!D3:D1000', 'Vendor!D3:D1000', 'Client!C3:C1000']) {
        const rows = await readRange(range);
        for (const row of rows) {
            if (row[0]) visited.add(row[0].replace('@', '').trim());
        }
    }
    console.log(`[SHEETS] Loaded ${visited.size} visited profiles`);
    return visited;
}

async function findNextHashtagIndex(approvedHashtags) {
    if (approvedHashtags.length === 0) return 0;
    const rows = await readRange('VendorHashtags!A1:G2000');
    let lastExecutedIdx = -1;
    for (let i = 2; i < rows.length; i++) {
        const h = rows[i];
        if (!h || !h[1]) continue;
        const name = h[1].toLowerCase();
        const gVal = (h[6] || '').trim();
        const idx = approvedHashtags.findIndex(hh => hh.toLowerCase() === name);
        if (idx < 0) continue;
        if (gVal.startsWith('Executed ')) lastExecutedIdx = idx;
    }
    return (lastExecutedIdx + 1) % approvedHashtags.length;
}

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

async function sheetsAppend(sheetName, endCol, values) {
    if (!sheetsClient) {
        console.log(`[SHEETS DRY] ${sheetName} APPEND:`, JSON.stringify(values).slice(0, 150));
        return false;
    }
    const range = `${sheetName}!A:${endCol}`;
    try {
        const res = await sheetsClient.spreadsheets.values.append({
            spreadsheetId: SHEETS_ID, range,
            valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', resource: { values }
        });
        return res.data?.updates?.updatedRows > 0;
    } catch (e) {
        console.log(`[SHEETS] Append error on ${sheetName}: ${e.message}`);
        return false;
    }
}

async function writeProfile(profile, existingUsernames) {
    if (!profile || !profile.username) return;
    const username = profile.username;
    if (existingUsernames.has(username)) {
        console.log(`  [SKIP] @${username} already saved`);
        return;
    }
    const sheetName = profile.type === 'competitor' ? 'Competitors'
        : profile.type === 'vendor' ? 'Vendor' : 'Client';
    await acquireLock(sheetName).prev;
    const lockState = {};
    _locks[sheetName] = _locks[sheetName].then(() => {
        lockState.release = () => { _locks[sheetName] = Promise.resolve(); };
    });
    try {
        if (!isIndonesian(profile.bio || '', [...(profile.hashtags || [])], profile.nativeLocation || '')) {
            console.log(`  [SKIP] @${username} — not Indonesian`);
            if (lockState.release) lockState.release();
            return;
        }
        const today = new Date().toISOString().split('T')[0];
        const hashtagsStr = [...(profile.hashtags || [])].join(' ');
        const collabsStr = [...(profile.collabs || [])].slice(0, 10).join(', ');
        const engRate = profile.engagementRate || 'N/A';
        const engDisplay = typeof engRate === 'number' ? `${engRate}%` : engRate;
        let values, endCol;
        if (profile.type === 'competitor') {
            values = [['', profile.displayName || username, profile.profileUrl || `https://instagram.com/${username}/`,
                `@${username}`, profile.location || '', profile.location ? 'JawaTengah' : '',
                profile.followers || 0, profile.following || 0, profile.posts || 0, '',
                engDisplay, hashtagsStr, profile.bio || '', 'Pending', collabsStr, today]];
            endCol = 'Q';
        } else if (profile.type === 'vendor') {
            values = [['', profile.displayName || username, profile.profileUrl || `https://instagram.com/${username}/`,
                `@${username}`, profile.category || 'Wedding Services', profile.location || '', profile.location ? 'JawaTengah' : '',
                profile.followers || 0, profile.following || 0, profile.posts || 0, '',
                engDisplay, hashtagsStr, profile.bio || '', 'Pending', collabsStr, today]];
            endCol = 'Q';
        } else {
            values = [['', profile.profileUrl || `https://instagram.com/${username}/`,
                `@${username}`, profile.sourceHashtag || '',
                (profile.bio || '').slice(0, 200), profile.nativeLocation || '', today]];
            endCol = 'G';
        }
        await sheetsAppend(sheetName, endCol, values);
        existingUsernames.add(username);
        console.log(`  [SAVED] @${username} to ${sheetName}`);
    } finally { if (lockState.release) lockState.release(); }
}

async function writeClientFromComment(clientData, existingUsernames) {
    if (!clientData || !clientData.username) return;
    const username = clientData.username.toLowerCase().replace('@', '');
    if (existingUsernames.has(username)) {
        console.log(`  [SKIP CLIENT] @${username} already saved`);
        return;
    }
    await acquireLock('Client').prev;
    const lockState = {};
    _locks.Client = _locks.Client.then(() => {
        lockState.release = () => { _locks.Client = Promise.resolve(); };
    });
    try {
        const today = new Date().toISOString().split('T')[0];
        await sheetsAppend('Client', 'H', [[
            '', `https://instagram.com/${username}/`, `@${username}`,
            clientData.via || 'comment', clientData.source || '',
            (clientData.commentText || clientData.text || '').slice(0, 200),
            clientData.location || '', today,
        ]]);
        existingUsernames.add(username);
        console.log(`  [SAVED CLIENT] @${username} via ${clientData.via || 'comment'}`);
    } finally { if (lockState.release) lockState.release(); }
}

async function persistState() { /* no-op: append mode, no row tracking needed */ }

export {
    initSheets, readHashtags, readVisitedProfiles, findNextHashtagIndex,
    writeProfile, writeClientFromComment, writeNewHashtag,
    readRange, persistState,
    clearExecutingMarkers, markHashtagExecuting, markHashtagDone,
};
