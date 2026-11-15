// Markdown images with a data: URL (DISP-104): shown for the bitmap types, in image sources only.
import { expect, test } from './fixtures.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64');

test('an item shows a data:image/png image; SVG and data: links stay out', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await page.request.post('/api/projects', { data: { key: 'IMG', name: 'Images' } });
  const item = await (await page.request.post('/api/projects/IMG/items', {
    data: {
      title: 'With an inline picture',
      body_md: `![dot](data:image/png;base64,${PNG})\n\n![vector](data:image/svg+xml;base64,${SVG})\n\n[a data link](data:image/png;base64,${PNG})\n\n[a page](data:text/html,hello)`,
    },
  })).json();
  await page.goto(`/items/${item.id}`);
  const dot = page.getByAltText('dot');
  await expect(dot).toHaveAttribute('src', `data:image/png;base64,${PNG}`);
  await expect.poll(() => dot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  // an SVG can carry script: its data: URL is still emptied
  expect(await page.getByAltText('vector').getAttribute('src')).not.toContain('data:');
  // links are sanitised as before
  for (const name of ['a data link', 'a page']) expect(await page.getByRole('link', { name }).getAttribute('href') ?? '').not.toContain('data:');
});
