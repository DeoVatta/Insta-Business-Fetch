# Insta-Business-Fetch

Automated Instagram business data extractor for Indonesian bridal/makeup market. Classifies profiles, discovers hashtags, and finds potential clients via comment analysis.

## Architecture

```
index.js              — Main pipeline orchestrator
src/
  scraper.js          — Playwright + GraphQL + oEmbed (no external IG lib)
  instagram-auth.js   — Auto cookie refresh via Playwright login
  enricher.js         — Profile enrichment + classification
  classifier.js       — Account type + location detection (Indonesian)
  comments.js         — GraphQL comment extraction + client scoring
  ai-classifier.js    — AI batch classification via Olagon Gateway
  sheets.js           — Google Sheets read/write (append mode)
  config.js           — All constants
```

**Confirmed working methods:**
1. Playwright → `/explore/search/keyword/?q=%23{hashtag}` → post URLs
2. oEmbed → public API → username + caption + hashtags (no auth, ~2000 posts/min)
3. Playwright → `/{username}/` → profile data (bio, followers, following)
4. GraphQL → `/graphql/query/` → post comments (with auto-retry on auth failure)

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

1. Go to [Google Cloud Console](https://console.cloud.google.com) → IAM → Service Accounts
2. Create a service account, download the JSON key
3. Save it as `gcp-service-account.json`
4. Share your Google Sheet with the service account email (`...@....iam.gserviceaccount.com`)

The pipeline expects two tabs:

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

> **Note:** Copy your Google Sheets ID from the URL: `docs.google.com/spreadsheets/d/YOUR_SHEETS_ID_HERE/edit`

### 4. Run

```bash
node index.js
```

The program processes **one hashtag per run**. Add hashtags to the Hashtags sheet with status `Pending`. Each run discovers new hashtags — they are queued automatically for future runs.

## Pipeline Flow

```
Sheet Hashtags → Pick first Pending → Process →
  Collect profiles (batch 10) → AI classify → WRITE immediately
  Collect hashtags → AI filter (business only) → Queue as Pending
Mark Executed → Next Pending hashtag → repeat
```

| Phase | Action |
|-------|--------|
| 1 | Scrape hashtag (Playwright scroll) |
| 2 | Enrich posts + collect hashtags |
| 3 | AI classify hashtags (business only) → write to Hashtags sheet |
| 4 | Enrich profiles → buffer 10 → AI batch → WRITE immediately |
| 5 | Comment extraction → client discovery |
| 6 | Discovery queue (batch 10 → WRITE immediately) |
| 7 | Re-login every 20 posts |

## Queue System

The program builds a self-growing hashtag queue:

```
#muasemarang | Pending  ← you add this
    ↓ Run #1
#muasemarang | Executed
#wosemarang  | Pending  ← discovered by AI, queued for next run
#bridaljogja | Pending  ← discovered by AI, queued
    ↓ Run #2
#wosemarang  | Executed
#bridaljogja| Pending  ← you add this manually or let it grow
#muasolo     | Pending  ← discovered, queued
    ↓ ...
```

- **Pending** = ready to be processed (user input OR AI discovery)
- **Executing** = currently being processed
- **Executed** = completed

Loop continues until no more Pending hashtags remain.

## AI Classification

**Claude Haiku** via Olagon Gateway. Key limits:

| Metric | Value |
|--------|-------|
| Max profiles per request | 150 (using 10 for visibility) |
| Max hashtags per request | 200 |
| Weekly quota | ~5 hours |
| Profiles/week (batch 10) | ~3,000+ |

AI does:
- **Profile**: Category, Location (city only), WhatsApp, Website, Engagement rate
- **Hashtag**: Business-related or not? Only business hashtags are queued

## Batch System

Profile batch = **10 profiles**. Every 10 profiles enriched → AI batch → **written to sheet immediately**.

```
Enrich 10 profiles (~5 min) → AI batch (~20s) → 10 rows appear in sheet
Enrich next 10 profiles → AI → 10 more rows
...progress visible in real-time
```

Discovery queue: same pattern (batch 10, write immediately).

## Key Features

- **Queue system**: Self-growing hashtag discovery — each run expands the queue
- **Immediate write**: Every batch → rows appear in sheet immediately (no waiting until end)
- **AI hashtag filter**: Only business-related hashtags enter the queue
- **Indonesian-only**: Skips non-Indonesian accounts via city/word detection
- **Auto-retry on GraphQL failure**: Stale sessionid triggers re-auth automatically
- **Sessionid valid ~362 days**: No mid-run login needed

## Troubleshooting

**GraphQL comments returning errors:**
```bash
node -e "import('./src/instagram-auth.js').then(m => m.ensureAuth())"
```

**Dry-run mode (no Sheets):**
Pipeline runs in dry-run mode if `gcp-service-account.json` is missing — all writes printed to console.

**Quota monitoring:**
Check `[AI]` log lines for batch counts. With batch 10, ~45 API calls per 5-hour run (well within 500 limit).

## License

Copyright (c) Devata. All Rights Reserved.
