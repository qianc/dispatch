// The Content-Security-Policy (DISP-72): the main pages work under it and break none of it. The
// page fixture fails a test on any violation the browser reports, in every spec file.
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('the main pages run under the full policy without a violation', async ({ page }) => {
  // pair: the page a phone opens before it is signed in
  await page.goto('/pair');
  expect((await page.request.get('/pair')).headers()['content-security-policy']).toContain("script-src 'self';");
  await expect(page.locator('#root > *').first()).toBeVisible();

  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  // the theme is set by a script file now, before the app starts
  await page.evaluate(() => localStorage.setItem('dispatch:theme', 'light'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  // the service worker registers under worker-src 'self'
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

  // a project whose item has an image from another https host, and an inline one
  await page.request.post('/api/projects', { data: { key: 'CSP', name: 'Policy' } });
  await page.request.post('/api/projects/CSP/repos', { data: { github_owner: 'me', github_name: 'policy', default_branch: 'main' } });
  const item = await (await page.request.post('/api/projects/CSP/items', {
    data: { title: 'With pictures', body_md: `![far](https://images.example/pic.png) ![near](data:image/png;base64,${PNG.toString('base64')})` },
  })).json();
  for (const tab of ['backlog', 'bugs', 'sessions', 'sources', 'settings']) {
    await page.goto(`/p/CSP?tab=${tab}`);
    await expect(page.getByRole('heading', { name: 'Policy' })).toBeVisible();
  }
  await expect(page.getByText('Changes are saved automatically')).toBeVisible();
  await page.goto(`/items/${item.id}`);
  // the far one is a link, not a fetch (DISP-144); the inline one loads under img-src data:
  await expect(page.getByRole('link', { name: 'far' })).toHaveAttribute('href', 'https://images.example/pic.png');
  await expect.poll(() => page.getByAltText('near').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);

  // a session: the live stream (connect-src 'self') brings the agent's messages
  await page.goto('/p/CSP');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Mark CSP-1 for the agent' }).click();
  await page.getByRole('button', { name: 'Start batch' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/s\/\d+/);
  await expect(page.getByText('Which approach should I take?')).toBeVisible();

  for (const [path, heading] of [['/settings', 'Settings'], ['/projects', 'Projects'], ['/activity', 'Activity'], ['/assistant', 'Assistant'], ['/', 'Inbox']]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
  }
});

test('the consent page shows its style, and Allow returns to the app', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  // the app it returns to: a real listener (a route does not see a redirect's next request)
  const app = createServer((_req, res) => res.end('back in the app')).listen(0, '127.0.0.1');
  await once(app, 'listening');
  const back = `http://127.0.0.1:${(app.address() as AddressInfo).port}/callback`;
  const { client_id } = await (await page.request.post('/register', { data: { client_name: 'Policy app', redirect_uris: [back] } })).json();
  await page.goto(`/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent(back)}&response_type=code&code_challenge=abc&code_challenge_method=S256&state=s1`);
  await expect(page.getByRole('heading', { name: 'Allow Policy app?' })).toBeVisible();
  // its one inline style is the one the policy names by hash
  await expect(page.getByRole('button', { name: 'Allow' })).toHaveCSS('background-color', /rgb\((79, 80, 230|110, 111, 240)\)/);
  // the form posts to Dispatch, which sends the browser on to the app: form-action names that origin
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(new RegExp(`^${back}\\?state=s1&code=`));
  await expect(page.getByText('back in the app')).toBeVisible();
  app.close();
});
