# Insta-Business-Fetch

Automated Instagram business data extractor for the Indonesian bridal/makeup artist market. Classifies MUA and wedding vendor profiles, discovers hashtags, and finds potential clients via comment analysis.

## Architecture

```
index.js              — Main pipeline orchestrator (Phase 1–11)
src/
  scraper.js          — Playwright + GraphQL + oEmbed (no external IG lib)
  instagram-auth.js   — Auto cookie refresh via Playwright login
  enricher.js         — Profile enrichment + classification
  classifier.js       — Account type + location detection (Indonesian)
  comments.js         — GraphQL comment extraction + client scoring
  sheets.js           — Google Sheets read/write (append mode, mutex locks)
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

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env`:
```
IG_USERNAME=your_instagram_username
IG_PASSWORD=your_instagram_password
GOOGLE_SHEETS_ID=your_google_sheets_id_here
```

### 3. Google Sheets service account

1. Go to [Google Cloud Console](https://console.cloud.google.com) → IAM → Service Accounts
2. Create a service account, download the JSON key
3. Save it as `gcp-service-account.json` in the project root
4. Share your Google Sheet (using the ID from `GOOGLE_SHEETS_ID`) with the service account email (`...@....iam.gserviceaccount.com`)

The pipeline expects a Google Sheet with these tabs:
- **Competitors** — MUA/profiles from hashtags
- **Vendor** — Wedding vendors (fotografer, catering, etc.)
- **Client** — Potential clients found via comment analysis
- **VendorHashtags** — Hashtags to scan (add hashtags in column B with status `OK` or `NEW`)

> **Note:** Copy your Google Sheets ID from the URL: `docs.google.com/spreadsheets/d/YOUR_SHEETS_ID_HERE/edit`

### 4. Run

```bash
node index.js
```

The pipeline processes one hashtag per run. On completion it marks the hashtag as "Executed" in the G column of VendorHashtags. Re-run to process the next hashtag.

## Pipeline Phases

| Phase | Description |
|-------|-------------|
| 1 | Scrape hashtag → collect all post URLs + oEmbed data |
| 2–6 | Loop posts: enrich profile → classify → write to sheet |
| 7 | Collect last 20 posts for comment extraction |
| 8 | GraphQL comment extraction → filter clients → write |
| 9 | Collab/mention queue → enrich → write (depth up to 2) |
| 10 | Re-login every 20 posts to refresh session cookies |

## Key Features

- **Auto-retry on GraphQL auth failure** — stale sessionid triggers re-auth automatically
- **Indonesian-only filtering** — skips non-Indonesian accounts using city/word detection
- **Real-time write** — every result is written to Sheets immediately (no batch delay)
- **No external IG library** — uses Playwright + oEmbed + GraphQL directly
- **Sessionid valid ~362 days** — no mid-run login needed (configured in .env)

## Troubleshooting

**GraphQL comments returning errors:**
The scraper now auto-retries with fresh auth on 401/403. If it keeps failing, re-harvest cookies:
```bash
node -e "import('./src/instagram-auth.js').then(m => m.ensureAuth())"
```

**"No approved hashtags" error:**
Add hashtags to the `VendorHashtags` sheet column B with status `OK` or `NEW` in column F.

**Dry-run mode (no Sheets):**
If `gcp-service-account.json` is missing, the pipeline runs in dry-run mode and prints all writes to console.

## License

Copyright (c) Devata. All Rights Reserved.
