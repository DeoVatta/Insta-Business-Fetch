import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIE_FILE = path.join(__dirname, 'instagram-cookies.json');

async function loadCookies(page) {
    if (!fs.existsSync(COOKIE_FILE)) {
        console.log('No cookie file found');
        return;
    }
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    await page.context().addCookies(cookies.filter(c => c.name && c.value));
    console.log(`Loaded ${cookies.length} cookies`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

await loadCookies(page);

// Try hashtag page format
const tag = 'muajogja';
const urls = [
    `https://www.instagram.com/explore/tags/${tag}/`,
    `https://www.instagram.com/t/${tag}/`,
    `https://www.instagram.com/hashtag/${tag}/`,
];

for (const url of urls) {
    console.log(`\nTesting: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log('URL:', page.url());
    const postLinks = await page.$$('a[href*="/p/"]');
    console.log('Posts found:', postLinks.length);
    const hrefs = await page.$$eval('a[href*="/p/"]', els => els.slice(0, 3).map(e => e.href));
    console.log('Sample:', hrefs);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 200));
    if (bodyText.includes('Something went wrong')) {
        console.log('BLOCKED');
    } else {
        console.log('OK - text:', bodyText.slice(0, 100));
    }
}

await browser.close();
