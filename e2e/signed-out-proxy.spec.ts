// DISP-107: a sign-in proxy (Entra, …) that answers a signed-out /api request with a redirect to
// its login. The app shows "Signed out" without a request the browser blocks, and the proxy's
// return address is not answered with the cached app shell.
import { expect, test } from './fixtures.ts';

test('an expired proxy session shows Signed out, and the proxy gets its return address', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  let asked = 0;
  await page.context().route('https://login.example/**', (r) => {
    asked++;
    return r.abort();
  });

  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  // the proxy's session ends: every /api request is sent to the login on another origin
  await page.context().route('**/api/**', (r) => r.fulfill({ status: 302, headers: { location: 'https://login.example/oauth2/v2.0/authorize?client_id=a' } }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // back in the app: it asks again
  await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible({ timeout: 15_000 });
  // a fresh start in that state: the shell comes from the cache, /api/me from the proxy
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible();
  // it goes on asking /me, but slowly (not once per answer)
  let me = 0;
  page.on('request', (r) => void (r.url().endsWith('/api/me') && me++));
  await page.waitForTimeout(5000);
  expect(me).toBeLessThan(4);
  expect(asked, 'requests to the login origin').toBe(0);
  expect(errors).toEqual([]);

  // back from the login: the proxy's return address reaches the network
  let returned = 0;
  await page.context().route('**/oauth2/callback?**', (r) => {
    returned++;
    return r.fulfill({ contentType: 'text/html', body: '<h1>proxy took the code</h1>' });
  });
  await page.goto('/oauth2/callback?code=1.ASEA&state=x');
  await expect(page.getByRole('heading', { name: 'proxy took the code' })).toBeVisible();
  expect(returned).toBe(1);
});
