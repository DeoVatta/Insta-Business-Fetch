/**
 * State Persistence — discovery-state.json
 *
 * Atomic write: write to .tmp → rename to .json
 * Auto-resume on crash/restart
 *
 * State shape:
 * {
 *   version: 1,
 *   savedAt: ISO string,
 *   currentHashtag: "#hashtag",
 *   hashtagStatus: "Executing",
 *   currentPhase: "profile-enrich" | "post-enrich" | "hashtag-scrape",
 *   currentItem: { username, depth, postIndex },
 *   queue: [{ username, depth, source, status: "pending"|"processing"|"done" }],
 *   visited: { [username]: { depth, enriched, postsCollected } },
 *   hashtags: { [tag]: { found, status, discoveredFrom } },
 *   stats: { profiles, clients, batches, hashtagsWritten }
 * }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'discovery-state.json');
const STATE_TMP = path.join(__dirname, '..', 'discovery-state.tmp.json');
const SAVE_EVERY = 10; // Save every N profiles

let state = null;
let pendingSave = false;
let saveTimer = null;

// ===== DEFAULT STATE =====
function createDefaultState() {
    return {
        version: 1,
        savedAt: new Date().toISOString(),
        currentHashtag: null,
        hashtagStatus: null,
        currentPhase: null,
        currentItem: null,
        queue: [],
        visited: {},
        hashtags: {},
        stats: {
            profiles: 0,
            clients: 0,
            batches: 0,
            hashtagsWritten: 0,
            aiProfiles: 0,
        },
        profileBuffer: [], // In-memory buffer not yet saved
    };
}

// ===== LOAD =====
export async function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            console.log('[STATE] No state file — fresh run');
            state = createDefaultState();
            return state;
        }

        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const loaded = JSON.parse(raw);

        // Validate
        if (!loaded.version || !Array.isArray(loaded.queue) || typeof loaded.visited !== 'object') {
            console.warn('[STATE] Corrupt state file — starting fresh');
            state = createDefaultState();
            return state;
        }

        state = loaded;

        // Hydrate stats
        if (!state.stats) state.stats = { profiles: 0, clients: 0, batches: 0, hashtagsWritten: 0, aiProfiles: 0 };
        if (!state.profileBuffer) state.profileBuffer = [];
        if (!state.hashtags) state.hashtags = {};

        const visitedCount = Object.keys(state.visited).length;
        const queueCount = state.queue.length;
        const pendingCount = state.queue.filter(q => q.status !== 'done').length;

        console.log(`[STATE] Resumed — ${visitedCount} visited, ${pendingCount} pending in queue`);
        if (state.currentHashtag) {
            console.log(`[STATE] Current hashtag: ${state.currentHashtag} (${state.hashtagStatus})`);
            console.log(`[STATE] Phase: ${state.currentPhase} | Item: ${JSON.stringify(state.currentItem)}`);
        }

        return state;
    } catch (e) {
        console.warn(`[STATE] Load error: ${e.message} — starting fresh`);
        state = createDefaultState();
        return state;
    }
}

// ===== SAVE (atomic: write .tmp → rename) =====
async function saveStateInternal() {
    if (!state) return;
    if (pendingSave) return; // Already saving

    pendingSave = true;
    state.savedAt = new Date().toISOString();

    try {
        const data = JSON.stringify(state, null, 0);
        fs.writeFileSync(STATE_TMP, data, 'utf8');
        fs.renameSync(STATE_TMP, STATE_FILE);
    } catch (e) {
        console.warn(`[STATE] Save error: ${e.message}`);
    } finally {
        pendingSave = false;
    }
}

// ===== SCHEDULED SAVE =====
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
        saveTimer = null;
        await saveStateInternal();
    }, 500); // Debounce 500ms
}

// ===== PUBLIC SAVE TRIGGERS =====
export function markDirty() {
    scheduleSave();
}

export async function forceSave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    await saveStateInternal();
}

// ===== QUEUE MANAGEMENT =====
export function getState() {
    return state;
}

export function setCurrentHashtag(hashtag, status) {
    state.currentHashtag = hashtag;
    state.hashtagStatus = status;
    markDirty();
}

export function setPhase(phase, item = null) {
    state.currentPhase = phase;
    state.currentItem = item;
    markDirty();
}

export function addToQueue(username, depth, source = 'hashtag') {
    if (state.visited[username.toLowerCase()]) return false;
    const existing = state.queue.find(q => q.username.toLowerCase() === username.toLowerCase() && q.status !== 'done');
    if (existing) return false;

    state.queue.push({
        username: username.toLowerCase(),
        depth,
        source,
        status: 'pending',
    });
    markDirty();
    return true;
}

export function getNextInQueue(maxDepth = 4) {
    // Priority: pending items sorted by depth (shallow first)
    const pending = state.queue
        .filter(q => q.status === 'pending' && q.depth <= maxDepth)
        .sort((a, b) => a.depth - b.depth);

    if (pending.length === 0) return null;

    const item = pending[0];
    item.status = 'processing';
    markDirty();
    return item;
}

export function markQueueDone(username) {
    const item = state.queue.find(q => q.username.toLowerCase() === username.toLowerCase());
    if (item) {
        item.status = 'done';
        markDirty();
    }
}

export function isVisited(username) {
    return !!state.visited[username.toLowerCase()];
}

export function markVisited(username, depth = 0, enriched = false) {
    const key = username.toLowerCase();
    if (!state.visited[key]) {
        state.visited[key] = { depth, enriched: false, postsCollected: 0 };
        state.stats.profiles++;
        markDirty();
    } else {
        // Update if new info is more complete
        if (depth > state.visited[key].depth) {
            state.visited[key].depth = depth;
        }
    }
    return state.visited[key];
}

export function markEnriched(username) {
    const key = username.toLowerCase();
    if (state.visited[key]) {
        state.visited[key].enriched = true;
        markDirty();
    }
}

export function getQueueStats() {
    const total = state.queue.length;
    const done = state.queue.filter(q => q.status === 'done').length;
    const pending = state.queue.filter(q => q.status === 'pending').length;
    const processing = state.queue.filter(q => q.status === 'processing').length;

    const byDepth = {};
    for (const q of state.queue) {
        if (q.status !== 'done') {
            byDepth[q.depth] = (byDepth[q.depth] || 0) + 1;
        }
    }

    return { total, done, pending, processing, byDepth };
}

// ===== HASHTAG TRACKING =====
export function addHashtag(tag, discoveredFrom = '') {
    const clean = tag.replace(/^#/, '').toLowerCase().trim();
    if (!clean) return;
    if (!state.hashtags[clean]) {
        state.hashtags[clean] = { found: 0, status: 'Pending', discoveredFrom };
    }
    state.hashtags[clean].found++;
    markDirty();
}

export function getHashtags() {
    return Object.entries(state.hashtags)
        .filter(([, h]) => h.status !== 'Executed')
        .map(([tag, h]) => ({ tag: '#' + tag, ...h }))
        .sort((a, b) => b.found - a.found);
}

// ===== STATS =====
export function incStats(key, value = 1) {
    if (!state.stats[key]) state.stats[key] = 0;
    state.stats[key] += value;
    markDirty();
}

// ===== PROFILE BUFFER (in-memory, not persisted until batch complete) =====
export function bufferProfile(profile) {
    state.profileBuffer.push(profile);
    if (state.profileBuffer.length >= SAVE_EVERY) {
        // Flush needed — caller should call flushProfileBuffer
    }
}

export function getProfileBuffer() {
    return state.profileBuffer;
}

export function clearProfileBuffer() {
    state.profileBuffer = [];
    markDirty();
}

// ===== STATS REPORT =====
export function printStats() {
    const v = Object.keys(state.visited).length;
    const q = getQueueStats();
    console.log(`[STATE] Visited: ${v} | Queue: ${q.pending} pending, ${q.processing} processing, ${q.done} done`);
    console.log(`[STATE] By depth: ${JSON.stringify(q.byDepth)}`);
    console.log(`[STATE] Stats: profiles=${state.stats.profiles}, ai=${state.stats.aiProfiles}, clients=${state.stats.clients}, batches=${state.stats.batches}`);
}

// ===== CLEAR STATE (for fresh start) =====
export async function clearState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            fs.unlinkSync(STATE_FILE);
        }
        if (fs.existsSync(STATE_TMP)) {
            fs.unlinkSync(STATE_TMP);
        }
    } catch (e) {
        console.warn(`[STATE] Clear error: ${e.message}`);
    }
    state = createDefaultState();
    console.log('[STATE] Cleared — fresh start');
}

// ===== CHECKPOINT (save on specific milestones) =====
export async function checkpoint(label) {
    await forceSave();
    console.log(`[STATE CHECKPOINT] ${label} — saved at ${state.savedAt}`);
}
