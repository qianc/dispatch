// The project icon picker (DISP-102): every icon is offered, fits a phone, and can be picked.
import { PROJECT_ICONS } from '../src/shared/projectLook.ts';
import { expect, test } from './fixtures.ts';

test('the picker offers every icon on a phone, and a project keeps the one picked', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await page.request.post('/api/projects', { data: { key: 'ICO', name: 'Icons' } });
  await page.goto('/p/ICO?tab=settings');
  const picker = page.getByRole('radiogroup', { name: 'Icon' });
  // the first-letter choice, then one button per icon
  await expect(picker.getByRole('radio')).toHaveCount(PROJECT_ICONS.length + 1);
  // none is cut off at the side of the screen
  const width = page.viewportSize()!.width;
  for (const box of await picker.getByRole('radio').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
  }
  for (const icon of ['rocket', 'coffee']) {
    await picker.getByRole('radio', { name: icon, exact: true }).click();
    await expect(picker.getByRole('radio', { name: icon, exact: true })).toBeChecked();
    await expect.poll(async () => (await (await page.request.get('/api/projects/ICO')).json()).icon).toBe(icon);
  }
  if (process.env.ICON_SHOT) await picker.screenshot({ path: process.env.ICON_SHOT, scale: 'device' });
});
