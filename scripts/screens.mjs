// Dev helper: screenshot screens on an iPhone viewport.
// usage: node scripts/screens.mjs <outdir> name=/path ...   (BASE_URL, CHROMIUM_PATH optional)
import { chromium, devices } from '@playwright/test';

const [out, ...shots] = process.argv.slice(2);
const base = process.env.BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices['iPhone 14'], colorScheme: 'dark' });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()));
for (const [name, path] of shots.map((a) => a.split('='))) {
  await page.goto(base + path);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${name}.png` });
}
await browser.close();
