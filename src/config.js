/**
 * Instagram Prospector - Config
 */

import dotenv from 'dotenv';
dotenv.config();

export const SERVICE_ACCOUNT_FILE = './gcp-service-account.json';

// Instagram credentials — set in .env
export const IG_USERNAME = process.env.IG_USERNAME || '';
export const IG_PASSWORD = process.env.IG_PASSWORD || '';

// Google Sheets output — set in .env
export const SHEETS_ID = process.env.GOOGLE_SHEETS_ID || '';

// Olagon AI Gateway — set in .env
export const OLAGON_API_KEY = process.env.OLAGON_API_KEY || '';
export const OLAGON_BASE_URL = process.env.OLAGON_BASE_URL || 'https://gateway.olagon.site';

// Limits
export const HASHTAGS_PER_RUN = 1;
export const MAX_COLLAB_DEPTH = 2;
export const POSTS_PER_HASHTAG = null;
export const PROFILES_PER_HASHTAG = null;
export const MAX_PROFILES_PER_RUN = null;
export const MAX_DISCOVERY_PROFILES = null;
export const REQUEST_DELAY = 5;
export const NAVIGATE_DELAY = 2000;
export const MAX_SCROLL_HASHTAG = 50;
export const MAX_API_ERRORS_CONSECUTIVE = 20;
export const MAX_NEW_PROFILE_THRESHOLD = 10;
export const PHASE2_TIMEOUT_MIN = 60;
export const PHASE3_TIMEOUT_MIN = 90;
export const SESSION_CHECK_EVERY = 50;
