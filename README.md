# Insta-Business-Fetch

Automated Instagram business data extractor for Indonesian bridal/makeup market. Runs 24/7 non-stop with nested depth-4 discovery, AI classification, and auto-resume on crash.

## Architecture

```
index.js              — Main pipeline orchestrator
src/
  state.js           — Persistence + auto-resume (discovery-state.json)
  scraper.js         — Playwright + GraphQL + oEmbed
  instagram-auth.js   — Auto cookie refresh via Playwright login
  enricher.js         — Profile enrichment + 20 posts enrichment
  classifier.js       — Account type + location detection (Indonesian)
  comments.js         — GraphQL comment extraction + client scoring
  ai-classifier.js   — AI batch classification via Olagon Gateway
  sheets.js           — Google Sheets read/write (append mode)
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
| A | No | ROW()-1 (manual formula) |
| B | Nama | Instagram Display Name |
| C | Instagram | Profile URL |
| D | Whatsapp | WhatsApp number (AI-extracted) |
| E | Website | Website URL (AI-extracted) |
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
| A | No | ROW()-1 (manual formula) |
| B | Hashtag | Hashtag name (e.g. #muasemarang) |
| C | Found | Times this hashtag was found |
| D | Status | Pending / Executing / Executed |

## Auth Setup (Required First)

Instagram requires a valid `sessionid` cookie. Two options:

### Option 1: Manual Login (Recommended for new accounts)
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
  Phase 1: Scrape hashtag → get all post URLs
  Phase 2: For each post:
    - Enrich post (username, caption, hashtags, mentions, collabs)
    - Collect hashtags → add to state
    - Check Indonesian → skip if not
    - Enrich profile → full nested enrichment (20 posts)
      → collect more hashtags, mentions, collabs
      → add to queue (depth+1)
    - Extract comments → filter clients → write immediately
    - Save state every 10 profiles
  Phase 3: AI classify collected hashtags → write business ones to sheet
  Phase 4: Process discovery queue (depth 2, 3, 4)
    - Full nested enrichment for each queued profile
    - Save state every 10 profiles
  Mark hashtag Executed → next hashtag

[REPEAT] Until all hashtags done → then wait or stop
```

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

```
{
  "version": 1,
  "savedAt": "2026-07-10T...",
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

## AI Classification

**Claude Haiku** via Olagon Gateway (no thinking block):

| Metric | Value |
|--------|-------|
| Batch size | 10 profiles |
| AI batches per 5hrs | ~45 (safe limit) |
| Profiles per 5hrs | ~450 |
| Profiles/week | ~3,000+ |

AI extracts: Category, Location (city), WhatsApp, Website, Engagement rate.

## Batch System

Profiles are buffered and written to sheet every 10 profiles via AI batch classification. Comment extraction writes immediately per post.

## Key Features

- **24/7 non-stop**: Runs forever, resumes on restart
- **Nested depth 4**: Full enrichment of 20 posts per profile at every depth level
- **Persistence**: Auto-save to `discovery-state.json`, auto-resume on crash
- **Immediate write**: Every batch written to sheet immediately — progress visible in real-time
- **AI hashtag filter**: Only business-related hashtags enter the queue
- **Indonesian-only**: Skips non-Indonesian accounts
- **Atomic saves**: Write to .tmp → rename to .json (no corruption on crash)

## Clear State (Fresh Start)

```bash
# Delete state file
rm discovery-state.json
```

Or add to config: `CLEAR_STATE=true node index.js`

## Troubleshooting

**GraphQL comments returning errors:**
```bash
node -e "import('./src/instagram-auth.js').then(m => m.ensureAuth())"
```

**Dry-run mode:** Pipeline runs dry-run if `gcp-service-account.json` is missing — all writes printed to console.

**State file corrupt:**
```
[STATE] Corrupt state file — starting fresh
```
State resets automatically. Progress up to last save point is lost.

**Quota monitoring:** Check `[AI]` log lines for batch counts.

## License

Copyright (c) Devata. All Rights Reserved.
