/**
 * Instagram Manual Auth — Standalone cookie exporter
 *
 * Opens Instagram in a visible browser so you can log in manually.
 * After successful login, exports all cookies to instagram-cookies.json.
 *
 * Usage:
 *   IG_USERNAME=your_username IG_PASSWORD=your_password node manual-auth.mjs
 *   # or just:
 *   node manual-auth.mjs
 *
 * Then complete login in the browser window.
 * Cookies will be saved automatically once sessionid is detected.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = path.join(__dirname, 'instagram-cookies.json');
const IG_USERNAME = process.env.IG_USERNAME || '';
const IG_PASSWORD = process.env.IG_PASSWORD || '';

async function saveCookies(cookies, reason) {
    const fixed = cookies.map(c => ({
        ...c,
        sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite || 'None')
    }));
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(fixed, null, 4));
    console.log(`[AUTH] Cookies saved to ${COOKIES_FILE} (${reason})`);
}

async function run() {
    const browser = await chromium.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    console.log('='.repeat(60));
    console.log('INSTAGRAM MANUAL AUTH');
    console.log('='.repeat(60));
    console.log('A browser will open. Please log in manually.');
    console.log('Complete any verification challenges (email/SMS).');
    console.log('Once logged in, this script will detect sessionid and save cookies.');
    console.log('='.repeat(60));

    // Load existing cookies to preserve non-session cookies
    let existingCookies = [];
    if (fs.existsSync(COOKIES_FILE)) {
        try {
            existingCookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
            await context.addCookies(existingCookies.filter(c => c.name && c.value));
            console.log(`[AUTH] Loaded ${existingCookies.length} existing cookies`);
        } catch { /* ignore */ }
    }

    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // If credentials provided, auto-fill and submit
    if (IG_USERNAME && IG_PASSWORD) {
        await page.waitForTimeout(2000);
        // Check if already logged in
        const url = page.url();
        if (!url.includes('/accounts/login')) {
            console.log('[AUTH] Already logged in — checking sessionid...');
        } else {
            // Try to fill credentials
            const usernameInput = page.locator('input[name="username"], input[type="text"]').first();
            const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
            try {
                if (await usernameInput.isVisible({ timeout: 3000 })) {
                    await usernameInput.fill(IG_USERNAME);
                    await passwordInput.fill(IG_PASSWORD);
                    await page.locator('button[type="submit"]').first().click();
                    console.log('[AUTH] Credentials filled and submitted');
                }
            } catch { /* manual login needed */ }
        }
    }

    console.log('[AUTH] Waiting for login (manual or auto)...');
    let sessionidFound = false;
    let checkCount = 0;

    // Poll for sessionid every 5 seconds
    while (!sessionidFound) {
        await page.waitForTimeout(5000);
        const cookies = await context.cookies('https://www.instagram.com');
        const sessionCookie = cookies.find(c => c.name === 'sessionid' && c.value);
        if (sessionCookie) {
            console.log(`[AUTH] sessionid found! (${sessionCookie.value.slice(0, 20)}...)`);
            await saveCookies(cookies, `sessionid confirmed, expires ${new Date(sessionCookie.expirationDate * 1000).toLocaleDateString()}`);
            sessionidFound = true;
            break;
        }
        checkCount++;
        // Also check the URL for successful login
        const currentUrl = page.url();
        if (!currentUrl.includes('/accounts/login') && !currentUrl.includes('/auth_platform')) {
            console.log(`[AUTH] Logged in (URL: ${currentUrl.slice(0, 60)}) — waiting for sessionid...`);
        } else if (checkCount % 12 === 0) {
            console.log(`[AUTH] Still waiting... (${checkCount * 5}s elapsed)`);
        }

        // Safety: stop after 10 minutes
        if (checkCount >= 120) {
            console.log('[AUTH] Timeout (10 min) — saving whatever cookies we have');
            const cookies = await context.cookies('https://www.instagram.com');
            await saveCookies(cookies, 'timeout');
            break;
        }
    }

    await browser.close();
    console.log('[AUTH] Done. You can now run: node index.js');
}

run().catch(e => {
    console.error('[AUTH] Error:', e.message);
    process.exit(1);
});
