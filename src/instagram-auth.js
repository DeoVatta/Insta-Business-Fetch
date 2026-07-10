/**
 * Instagram Prospector - Auto cookie refresh via Playwright login
 *
 * Reads IG_USERNAME + IG_PASSWORD from config.js (loaded from .env).
 * If cookies are invalid/expired, auto-login and save new cookies.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { IG_USERNAME, IG_PASSWORD } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = path.join(__dirname, '..', 'instagram-cookies.json');
const USERNAME = IG_USERNAME;
const PASSWORD = IG_PASSWORD;

async function saveCookies(cookies) {
    const fixed = cookies.map(c => ({
        ...c,
        sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite || 'None')
    }));
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(fixed, null, 4));
    console.log(`[AUTH] Cookies saved`);
}

async function loadCookies() {
    if (!fs.existsSync(COOKIES_FILE)) return null;
    try {
        return JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    } catch {
        return null;
    }
}

async function checkSessionValidity(cookies) {
    if (!cookies || cookies.length === 0) return false;
    const sessionCookie = cookies.find(c => c.name === 'sessionid');
    if (!sessionCookie?.expirationDate || !sessionCookie?.value) return false;
    const daysLeft = Math.round((sessionCookie.expirationDate - Date.now() / 1000) / 86400);
    console.log(`[AUTH] sessionid expires in ~${daysLeft} days`);
    return daysLeft > 7;
}

async function loginInstagram(username, password) {
    console.log(`[AUTH] Attempting login for @${username}...`);
    const browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {} };
    });

    async function findInput(selector, label) {
        const selectors = typeof selector === 'string' ? [selector] : selector;
        for (const s of selectors) {
            try {
                const el = page.locator(s).first();
                if (await el.isVisible({ timeout: 3000 })) {
                    console.log(`[AUTH] Found ${label}: ${s}`);
                    return el;
                }
            } catch { /* try next */ }
        }
        return null;
    }

    try {
        await page.goto('https://www.instagram.com/accounts/login/', { timeout: 30000 });
        await page.waitForTimeout(3000);

        // Handle "This was you?" challenge
        const challengeText = await page.locator('text="This was you?"').isVisible().catch(() => false);
        if (challengeText) {
            await page.locator('button:has-text("Yes")').first().click();
            await page.waitForTimeout(3000);
        }

        const usernameInput = await findInput([
            'input[name="username"]', 'input[aria-label="Username"]',
            'input[placeholder*="username" i]', 'input[type="text"]'
        ], 'username');
        if (!usernameInput) throw new Error('Could not find username input');
        await usernameInput.fill(username);
        await page.waitForTimeout(500);

        const passwordInput = await findInput([
            'input[name="password"]', 'input[aria-label="Password"]',
            'input[type="password"]'
        ], 'password');
        if (!passwordInput) throw new Error('Could not find password input');
        await passwordInput.fill(password);
        await page.waitForTimeout(500);

        // Submit
        let clicked = false;
        for (const s of ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Sign in")']) {
            try {
                const btn = page.locator(s).first();
                if (await btn.isVisible({ timeout: 2000 })) {
                    await btn.click();
                    clicked = true;
                    break;
                }
            } catch { /* try next */ }
        }
        if (!clicked) await passwordInput.press('Enter');

        await page.waitForTimeout(6000);

        // Handle 2FA / verification challenge
        if (page.url().includes('/auth_platform/recaptcha') || page.url().includes('/challenge/')) {
            console.log('[AUTH] Challenge detected — waiting...');
            for (let i = 0; i < 30; i++) {
                await page.waitForTimeout(1000);
                if (!page.url().includes('/challenge/') && !page.url().includes('/auth_platform/')) break;
            }
        }

        // Handle "Save Info" / "Not Now" prompt
        try {
            const saveBtn = page.locator('button:has-text("Save Info"), button:has-text("Not Now")').first();
            if (await saveBtn.isVisible({ timeout: 3000 })) {
                await saveBtn.click();
                await page.waitForTimeout(2000);
            }
        } catch { /* no prompt */ }

        if (page.url().includes('/accounts/login')) {
            const errorText = await page.locator('#slfErrorAlert').textContent().catch(() => '');
            console.log(`[AUTH] Login FAILED: ${errorText}`);
            await browser.close();
            return null;
        }

        console.log('[AUTH] Login SUCCESS');
        await page.waitForTimeout(3000);

        const cookies = await context.cookies('https://www.instagram.com');
        const hasSessionId = cookies.some(c => c.name === 'sessionid' && c.value);
        if (!hasSessionId) {
            await page.waitForTimeout(5000);
            const cookiesRetry = await context.cookies('https://www.instagram.com');
            if (cookiesRetry.some(c => c.name === 'sessionid' && c.value)) {
                await browser.close();
                return cookiesRetry;
            }
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

export async function ensureAuth() {
    const existingCookies = await loadCookies();
    const hasSessionId = existingCookies?.some(c => c.name === 'sessionid' && c.value);

    if (hasSessionId) {
        const isValid = await checkSessionValidity(existingCookies);
        if (isValid) {
            console.log('[AUTH] Session valid — using existing cookies');
            return existingCookies;
        }
        console.log('[AUTH] Session expired — will refresh');
    }

    if (!USERNAME || !PASSWORD) {
        console.log('[AUTH] No sessionid and no credentials — update .env (IG_USERNAME + IG_PASSWORD)');
        process.exit(1);
    }

    const newCookies = await loginInstagram(USERNAME, PASSWORD);
    if (newCookies) {
        await saveCookies(newCookies);
        return newCookies;
    }
    return null;
}
