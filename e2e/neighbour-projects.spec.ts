// Neighbour projects (DISP-126): the owner ticks which projects a project's sessions may file into.
import { expect, test } from './fixtures.ts';

test('the owner ticks a neighbour project in the settings, one way', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  for (const [key, name] of [['NSL', 'Slides'], ['NTD', 'Techdoc'], ['NOT', 'Other']]) await page.request.post('/api/projects', { data: { key, name } });
  await page.goto('/p/NSL?tab=settings');
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Neighbour projects' }) });
  await expect(section.getByRole('checkbox')).not.toHaveCount(0);
  const techdoc = section.getByRole('checkbox', { name: /Techdoc/ });
  await techdoc.click(); // it shows the saved state, so it ticks once the save is back
  await expect.poll(async () => (await (await page.request.get('/api/projects/NSL')).json()).neighbours).toEqual(['NTD']);
  await expect(techdoc).toBeChecked();
  await expect(section.getByRole('checkbox', { name: /Other/ })).not.toBeChecked();
  // one way: Techdoc's sessions do not get Slides
  expect((await (await page.request.get('/api/projects/NTD')).json()).neighbours).toEqual([]);
  if (process.env.NEIGHBOUR_SHOT) await section.screenshot({ path: process.env.NEIGHBOUR_SHOT, scale: 'device' });
});
