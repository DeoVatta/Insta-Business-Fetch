# Insta-Business-Fetch

Automated Instagram business data extractor for Indonesian bridal/makeup market. Runs 24/7 non-stop with nested depth-4 discovery, AI classification, and auto-resume on crash.

## Architecture

```
index.js              — Main pipeline orchestrator
src/
  state.js           — Persistence + auto-resume (discovery-state.json)
  scraper.js         — Playwright browser automation (hashtag scrape, post enrich, oEmbed)
  instagram-auth.js   — Auto cookie refresh via Playwright login
  enricher.js         — Profile enrichment + 20 posts enrichment
  classifier.js       — Account type + location detection (Indonesian)
  comments.js         — GraphQL comment extraction + client scoring
  ai-classifier.js   — AI batch classification via Olagon Gateway
  sheets.js           — Google Sheets read/write (append mode, buffered batch)
  config.js           — All constants
```

**State file:** `discovery-state.json` — persists queue, visited profiles, hashtags, stats. Auto-resume on restart.

## Setup

### 1. Clone & Install

```bash
git clone https://github.com/DeoVatta/Insta-Business-Fetch.git
cd Insta-Business-Fetch
npm install
```

### 2. Environment variables

```bash
cp .env.example .env
```

Edit `.env`:
```
IG_USERNAME=your_instagram_username
IG_PASSWORD=your_instagram_password
GOOGLE_SHEETS_ID=your_google_sheets_id_here
OLAGON_API_KEY=your_olagon_api_key_here
OLAGON_BASE_URL=https://gateway.olagon.site
```

### 3. Google Sheets service account

1. Share your Google Sheet with: `claude@cogent-range-458804-r9.iam.gserviceaccount.com`
2. Or create your own: Google Cloud Console → IAM → Service Accounts → download JSON → save as `gcp-service-account.json`

**Sheet tabs:**

**Sheet 1 — Instagram (A-L):**
| Col | Header | Description |
|-----|--------|-------------|
| A | No | ROW()-1 formula |
| B | Nama | Instagram Display Name |
| C | Instagram | Profile URL |
| D | Whatsapp | WhatsApp number (extracted from bio) |
| E | Website | Website URL (extracted from bio) |
| F | Category | Business category (AI-classified) |
| G | Followers | Follower count |
| H | Post | Number of posts |
| I | Location | Business location (city) |
| J | Last Post | URL of most recent post |
| K | Analytics | Engagement rate |
| L | Status | Manual input by user |

**Sheet 2 — Hashtags (A-D):**
| Col | Header | Description |
|-----|--------|-------------|
| A | No | ROW()-1 formula |
| B | Hashtag | Hashtag name (e.g. #muasemarang) |
| C | Found | Times this hashtag was found |
| D | Status | Pending / Executing / Executed |

## Auth Setup (Required First)

Instagram requires a valid `sessionid` cookie. Two options:

### Option 1: Manual Login (Recommended)
```bash
node manual-auth.mjs
```
A visible browser opens. Log in manually, complete any email/SMS verification. Cookies are saved automatically once sessionid is detected.

### Option 2: Auto-Login (May trigger reCAPTCHA)
```bash
node index.js
```
Uses Playwright to fill credentials and log in. If Instagram shows a reCAPTCHA challenge, use Option 1 instead.

**Important:** Instagram may require manual verification (email/SMS) especially for accounts without phone verification or new logins. Complete verification in the browser window.

## Running

```bash
node index.js
```

The program runs **24/7 non-stop**. It processes hashtags sequentially, and resumes automatically from `discovery-state.json` on restart.

**Add hashtags:** Put hashtags in the Hashtags sheet with status `Pending`. Program picks them up automatically.

## Pipeline Flow

```
[START] Load discovery-state.json
  └─ If exists → Resume from saved state
  └─ If not → Fresh start

[PER HASHTAG]
  Phase 1: Scrape hashtag page → get all post URLs (scrollTo bottom + waitForSelector img)
  Phase 2: For each post:
    - Enrich post (username, caption, hashtags, mentions, collabs)
    - Collect hashtags → add to state
    - Check Indonesian → skip if not
    - Enrich profile → full nested enrichment (20 posts)
      → collect more hashtags, mentions, collabs
      → add to queue (depth+1)
    - Extract comments → filter clients → write immediately
    - Save state every 10 profiles
  Phase 3: AI classify collected hashtags → write business ones to Hashtags sheet
  Phase 4: Process discovery queue (depth 2, 3, 4)
    - Full nested enrichment for each queued profile
    - Save state every 10 profiles
  Mark hashtag Executed → next hashtag

[REPEAT] Until all hashtags done → then reset to Pending for re-scan
```

## Pipeline Phases

### Phase 1: Hashtag Scrape
- URL: `https://www.instagram.com/explore/tags/{hashtag}/`
- Scroll: `scrollTo(0, document.body.scrollHeight)` + wait for images
- Selector: `article a[href*="/p/"]` with broader fallback
- Stop: 8 consecutive empty scrolls OR 50 max scrolls
- **Confirmed: ~66 posts per hashtag (tested #umkm)**

### Phase 2: Post & Profile Enrichment
- oEmbed API: enrich posts (username, caption, hashtags, mentions, collabs)
- Profile enrichment: bio, followers, category, location
- Nested enrichment: 20 posts per profile
- Comment extraction: GraphQL API (may return 302 on some accounts)

### Phase 3: AI Hashtag Classification
- Batch classify collected hashtags via AI (Olagon Gateway)
- Write business-related hashtags to Hashtags sheet

### Phase 4: Discovery Queue (Depth 2-4)
- Process profiles discovered from mentions/collabs
- Full nested enrichment at each depth level

## Nested Depth Discovery

```
Depth 1: Profiles from hashtag posts
         └─ Enrich 20 recent posts → collect hashtags + mentions + collabs

Depth 2: Profiles from depth 1 mentions/collabs
         └─ Enrich 20 recent posts → collect hashtags + mentions + collabs

Depth 3: Profiles from depth 2 mentions/collabs
         └─ Enrich 20 recent posts → collect hashtags + mentions + collabs

Depth 4: Profiles from depth 3 mentions/collabs
         └─ Enrich 20 recent posts → collect hashtags + mentions + collabs
```

**Time per profile:** ~10.5 minutes (profile + 20 posts full enrichment)

## Persistence & Auto-Resume

**State file:** `discovery-state.json`

```json
{
  "version": 1,
  "savedAt": "2026-07-11T...",
  "currentHashtag": "#muasemarang",
  "currentPhase": "profile-nested",
  "queue": [...],
  "visited": {...},
  "hashtags": {...},
  "stats": {...}
}
```

**What is persisted:**
- All visited profiles (never re-process)
- Discovery queue with depth tracking
- Collected hashtags with counts
- Current phase and item
- Stats (profiles, clients, batches)

**Auto-resume behavior:**
```
$ node index.js
[STATE] Resumed — 234 visited, 89 pending in queue
[STATE] Current hashtag: #muasemarang (Executing)
[STATE] Phase: profile-enrich | Item: {"username":"mua_jogja","depth":2}
[RUN] Queue: 89 pending, Depth max: 4
```

**Save frequency:** Every 10 profiles + on batch complete + on abort/crash.

**Crash recovery:** Max 10 profiles lost (last save interval).

## Sheets Buffer System

Profiles are buffered in memory and flushed to Google Sheets every 10 profiles OR every 30 seconds (whichever comes first). On flush, all buffered profiles are AI-classified in a single batch, then written to Sheets via one API call.

**Why:** Google Sheets has a 60 writes/minute quota. Batching avoids hitting this limit.

## AI Classification

**Claude Haiku** via Olagon Gateway (no thinking block):

| Metric | Value |
|--------|-------|
| Batch size | 10 profiles |
| AI batches per 5hrs | ~45 (safe limit) |
| Profiles per 5hrs | ~450 |
| Profiles/week | ~3,000+ |

AI extracts: Category, Location (city), WhatsApp, Website, Engagement rate.

## Known Issues

- **GraphQL comments 302**: Some requests return 302 redirect — comment extraction may be empty for some posts. Non-blocking.
- **Sheet ensure error**: "Request contains an invalid argument" on first run — sheets still connected and functional.

## Troubleshooting

**Session expired:**
```bash
node manual-auth.mjs
```

**Dry-run mode:** Pipeline runs dry-run if `gcp-service-account.json` is missing — all writes printed to console.

**State file corrupt:**
```
[STATE] Corrupt state file — starting fresh
```
State resets automatically. Progress up to last save point is lost.

**Hashtag scraping returns 0 posts:**
- Cookie may be expired → run `node manual-auth.mjs`
- Instagram may be blocking → try refreshing session

**Quota monitoring:** Check `[AI]` log lines for batch counts.

## Clear State (Fresh Start)

```bash
rm discovery-state.json
```

Or add to config: `CLEAR_STATE=true node index.js`

## License

Copyright (c) Devata. All Rights Reserved.
