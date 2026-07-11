/**
 * Instagram Prospector - Config
 */

import dotenv from 'dotenv';
dotenv.config();

// Use service account file from parent directory
export const SERVICE_ACCOUNT_FILE = './gcp-service-account.json';
export const COOKIES_FILE = './instagram-cookies.json';
export const SHEETS_ID = process.env.GOOGLE_SHEETS_ID || '';

// Limits
export const HASHTAGS_PER_RUN = 1;              // 1 hashtag per run for maximum focus
export const MAX_COLLAB_DEPTH = 2;              // Discovery depth (Phase 3)
export const POSTS_PER_HASHTAG = null;         // null = no limit (scroll until Instagram's lazy-load exhausts)
export const PROFILES_PER_HASHTAG = null;        // null = no limit (all usernames from hashtag)
export const MAX_PROFILES_PER_RUN = null;        // null = no limit (all Phase 2 profiles processed)
export const MAX_DISCOVERY_PROFILES = null;     // null = no limit (Phase 3 unlimited, guarded by safety)
export const REQUEST_DELAY = 10;                // seconds between API calls (reduced rate-limit risk)
export const NAVIGATE_DELAY = 3000;             // ms wait after page navigation
export const MAX_SCROLL_HASHTAG = 50;           // max scrolls on hashtag search page (safety cap)
export const MAX_API_ERRORS_CONSECUTIVE = 20;   // stop if N consecutive API errors (rate limit / session expired)
export const MAX_NEW_PROFILE_THRESHOLD = 10;     // stop Phase 3 if N consecutive profiles already seen
export const PHASE2_TIMEOUT_MIN = 60;           // Phase 2 timeout in minutes
export const PHASE3_TIMEOUT_MIN = 90;           // Phase 3 timeout in minutes
export const SESSION_CHECK_EVERY = 50;          // verify session cookies every N profile enrichments

// AI / Olagon
export const OLAGON_API_KEY = process.env.OLAGON_API_KEY || '';
export const OLAGON_BASE_URL = process.env.OLAGON_BASE_URL || 'https://gateway.olagon.site/anthropic';
