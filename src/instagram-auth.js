/**
 * Instagram Auth - Auto cookie refresh via Playwright login
 *
 * Reads IG_USERNAME + IG_PASSWORD from environment or .env file.
 * If cookies are invalid/expired, auto-login and save new cookies.
 *
 * Usage:
 *   IG_USERNAME=your_username IG_PASSWORD=your_password node index.js
 *   # or put in .env:
 *   IG_USERNAME=your_username
 *   IG_PASSWORD=your_password
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = path.join(__dirname, '..', 'instagram-cookies.json');
const IG_USERNAME = process.env.IG_USERNAME || '';
const IG_PASSWORD = process.env.IG_PASSWORD || '';

async function saveCookies(cookies) {
    // Fix sameSite: no_restriction → None
    const fixed = cookies.map(c => ({
        ...c,
        sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite || 'None')
    }));
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(fixed, null, 4));
    console.log(`[AUTH] Cookies saved to ${COOKIES_FILE}`);
}

async function loadCookies() {
    if (!fs.existsSync(COOKIES_FILE)) return null;
    try {
        return JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Quick session check — validate sessionid expiration.
 * Returns true if session is still valid (>7 days left).
 */
async function checkSessionValidity(cookies) {
    if (!cookies || cookies.length === 0) return false;
    const sessionCookie = cookies.find(c => c.name === 'sessionid');
    if (!sessionCookie?.expirationDate) return false;
    if (!sessionCookie?.value) return false;

    const now = Date.now() / 1000;
    const daysLeft = Math.round((sessionCookie.expirationDate - now) / 86400);
    console.log(`[AUTH] sessionid expires in ~${daysLeft} days`);
    return daysLeft > 7;
}

async function loginInstagram(username, password) {
    console.log(`[AUTH] Attempting login for @${username}...`);
    const browser = await chromium.launch({
        headless: false, // Need visible browser for login
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // Stealth: hide automation flags
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {} };
    });

    async function findInput(selector, label) {
        const selectors = typeof selector === 'string'
            ? [selector]
            : selector;
        for (const s of selectors) {
            try {
                const el = page.locator(s).first();
                if (await el.isVisible({ timeout: 3000 })) {
                    console.log(`[AUTH] Found ${label} via: ${s}`);
                    return el;
                }
            } catch { /* try next */ }
        }
        return null;
    }

    try {
        // Navigate to login page
        await page.goto('https://www.instagram.com/accounts/login/', { timeout: 30000 });
        await page.waitForTimeout(3000);

        // Check for "This was you?" challenge page
        const challengeText = await page.locator('text="This was you?"').isVisible().catch(() => false);
        if (challengeText) {
            console.log('[AUTH] Detected "This was you?" challenge — clicking Yes');
            await page.locator('button:has-text("Yes")').first().click();
            await page.waitForTimeout(3000);
        }

        // Try multiple selectors for username input
        const usernameSelectors = [
            'input[name="username"]',
            'input[aria-label="Username"]',
            'input[placeholder*="username" i]',
            'input[placeholder*="Phone" i]',
            'input[type="text"]',
            'input#email',
        ];
        const usernameInput = await findInput(usernameSelectors, 'username');
        if (!usernameInput) throw new Error('Could not find username input');
        await usernameInput.fill(username);
        await page.waitForTimeout(500);

        // Try multiple selectors for password input
        const passwordSelectors = [
            'input[name="password"]',
            'input[aria-label="Password"]',
            'input[placeholder*="password" i]',
            'input[type="password"]',
        ];
        const passwordInput = await findInput(passwordSelectors, 'password');
        if (!passwordInput) throw new Error('Could not find password input');
        await passwordInput.fill(password);
        await page.waitForTimeout(500);

        // Submit: try multiple submit buttons
        const submitSelectors = [
            'button[type="submit"]',
            'button:has-text("Log in")',
            'button:has-text("Log in")',
            'button:has-text("Sign in")',
            'div[role="button"]:has-text("Log in")',
        ];
        let clicked = false;
        for (const s of submitSelectors) {
            try {
                const btn = page.locator(s).first();
                if (await btn.isVisible({ timeout: 2000 })) {
                    await btn.click();
                    clicked = true;
                    console.log(`[AUTH] Clicked submit: ${s}`);
                    break;
                }
            } catch { /* try next */ }
        }
        if (!clicked) {
            // Try pressing Enter on password field
            await passwordInput.press('Enter');
            console.log('[AUTH] Pressed Enter on password field');
        }

        await page.waitForTimeout(6000);

        // Check for 2FA / verification challenge
        const url = page.url();
        if (url.includes('/auth_platform/recaptcha') || url.includes('/challenge/')) {
            console.log('[AUTH] Challenge detected — waiting up to 5 min for completion...');
            console.log('[AUTH] If browser is visible: complete the challenge in the browser window');
            // Wait up to 5 min for redirect away from challenge (manual verification needed)
            for (let i = 0; i < 60; i++) {
                await page.waitForTimeout(5000);
                const currentUrl = page.url();
                if (!currentUrl.includes('/challenge/') && !currentUrl.includes('/auth_platform/')) {
                    console.log(`[AUTH] Challenge passed — redirected to: ${currentUrl.substring(0, 60)}`);
                    break;
                }
                if (i % 12 === 0) console.log(`[AUTH] Still on challenge page... (${i * 5}s elapsed)`);
            }
        }

        // Handle "Save Info" / "Not Now" prompt
        try {
            const saveBtn = page.locator('button:has-text("Save Info"), button:has-text("Not Now")').first();
            if (await saveBtn.isVisible({ timeout: 3000 })) {
                await saveBtn.click();
                console.log('[AUTH] Handled save info prompt');
                await page.waitForTimeout(2000);
            }
        } catch { /* no prompt */ }

        const finalUrl = page.url();
        console.log(`[AUTH] After login URL: ${finalUrl}`);

        if (finalUrl.includes('/accounts/login')) {
            const errorText = await page.locator('#slfErrorAlert, [role="alert"]').textContent().catch(() => '');
            console.log(`[AUTH] Login FAILED — ${errorText || 'check credentials'}`);
            await browser.close();
            return null;
        }

        console.log(`[AUTH] Login SUCCESS`);
        await page.waitForTimeout(3000);

        // Extract cookies — verify sessionid is present before returning
        const cookies = await context.cookies('https://www.instagram.com');
        const hasSessionId = cookies.some(c => c.name === 'sessionid' && c.value);
        if (!hasSessionId) {
            console.log(`[AUTH] Login succeeded but no sessionid in cookies — retrying...`);
            await page.waitForTimeout(5000);
            const cookiesRetry = await context.cookies('https://www.instagram.com');
            const hasSessionIdRetry = cookiesRetry.some(c => c.name === 'sessionid' && c.value);
            if (hasSessionIdRetry) {
                console.log(`[AUTH] sessionid found on retry`);
                await browser.close();
                return cookiesRetry;
            }
            console.log(`[AUTH] WARNING: no sessionid found — Instagram challenge/verification required`);
            await browser.close();
            return null;  // Return null so caller knows login didn't produce sessionid
        }

        console.log(`[AUTH] Extracted ${cookies.length} cookies (sessionid confirmed)`);
        await browser.close();
        return cookies;

    } catch (e) {
        console.log(`[AUTH] Login error: ${e.message}`);
        await browser.close();
        return null;
    }
}

/**
 * Main auth function:
 * 1. Load existing cookies
 * 2. If valid (>7 days) → use them
 * 3. If IG_USERNAME + IG_PASSWORD provided → auto-login
 * 4. If no credentials → exit with instructions
 */
export async function ensureAuth() {
    const existingCookies = await loadCookies();
    const hasSessionId = existingCookies?.some(c => c.name === 'sessionid' && c.value);

    if (hasSessionId) {
        const isValid = await checkSessionValidity(existingCookies);
        if (isValid) {
            console.log('[AUTH] Session valid — using existing cookies');
            return existingCookies;
        }
        console.log('[AUTH] Session expired — will try to merge with browser cookies');
        // Return existing cookies so caller can merge with fresh browser cookies
        return existingCookies;
    }

    // No sessionid found — try auto-login if credentials available
    if (IG_USERNAME && IG_PASSWORD) {
        // Retry loop: challenge may require manual verification in browser
        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`[AUTH] Attempt ${attempt}/3: Logging in as @${IG_USERNAME}...`);
            const newCookies = await loginInstagram(IG_USERNAME, IG_PASSWORD);
            if (newCookies && newCookies.some(c => c.name === 'sessionid' && c.value)) {
                await saveCookies(newCookies);
                return newCookies;
            }
            if (newCookies === null) {
                // Challenge prevented sessionid — user may need to verify in browser
                // browser is already closed by loginInstagram, retry opens fresh browser
                console.log(`[AUTH] No sessionid (challenge pending). Retrying...`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            // Empty/null cookies — retry
            console.log(`[AUTH] Empty cookies returned, retrying...`);
            await new Promise(r => setTimeout(r, 2000));
        }
        console.log('[AUTH] Auto-login exhausted — use: node manual-auth.mjs');
        process.exit(1);
    }
    console.log('[AUTH] No sessionid in cookies — cannot authenticate');
    console.log('[AUTH] Update instagram-cookies.json with valid session cookies');
    process.exit(1);
}
