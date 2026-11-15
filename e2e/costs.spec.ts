import { expect, test, type Page } from './fixtures.ts';

// DISP-16: the cost and time view shows what a project's sessions cost, per item (a batch's cost
// in equal shares), per item type and per tag, and all projects together.

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
}

test('phone: a project\'s cost and time, per item, type and tag, and all projects', async ({ page }) => {
  await login(page);
  const api = async (path: string, data: unknown) => (await page.request.post(`/api${path}`, { data })).json();
  await api('/projects', { key: 'CST', name: 'Costly' });
  await api('/projects/CST/repos', { github_owner: 'me', github_name: 'cst' });
  const feature = await api('/projects/CST/items', { title: 'Export to PDF', labels: ['export'] });
  const bug = await api('/projects/CST/items', { title: 'Crash on save', type: 'bug' });

  // one batch for both items: the fake agent's turn costs $0.50
  const s = await api('/projects/CST/batches', { item_ids: [feature.id, bug.id], prompt: '', force_plan: false });
  await page.goto(`/s/${s.id}`);
  await page.getByRole('button', { name: /Small fix/ }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByText('Your turn')).toBeVisible();

  // from the project's Sessions tab
  await page.goto('/p/CST?tab=sessions');
  await page.getByRole('link', { name: 'Cost and time' }).click();
  await expect(page).toHaveURL(/\/p\/CST\/costs$/);
  await expect(page.getByRole('heading', { name: 'Cost and time' })).toBeVisible();
  await expect(page.getByLabel('Total cost and run time')).toContainText('$0.50');
  await expect(page.getByText('1 session · 2 items')).toBeVisible();

  // each item has half of the batch, and opens the item
  const row = (name: string | RegExp) => page.getByRole('listitem').filter({ hasText: name });
  await expect(row('Export to PDF')).toContainText('$0.25');
  await expect(row('Export to PDF')).toContainText('Backlog · export · 1 session');
  await expect(row('Crash on save')).toContainText('$0.25');
  await expect(row('Crash on save')).toContainText('Bug · 1 session');

  // by item type and by tag
  await page.getByRole('radio', { name: 'Type' }).click();
  await expect(row('Bugs')).toContainText('$0.25');
  await expect(row('Bugs')).toContainText('1 item · 1 session · avg $0.25');
  await expect(row('Backlog items')).toContainText('$0.25');
  await page.getByRole('radio', { name: 'Tag' }).click();
  await expect(row('export')).toContainText('$0.25');
  await expect(row('No tag')).toContainText('$0.25');
  await expect(page.getByText('can add up to more than the total')).toBeVisible();

  // nothing is wider than the phone's screen
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // a period with no sessions is not in the way: the last 30 days hold this batch
  await page.getByRole('radio', { name: '30 days' }).click();
  await expect(page.getByLabel('Total cost and run time')).toContainText('$0.50');

  // all projects, from the Projects screen; the project's line opens its own view
  await page.goto('/projects');
  await page.getByRole('link', { name: 'Costs' }).click();
  await expect(page).toHaveURL(/\/costs$/);
  await expect(page.getByText('All projects')).toBeVisible();
  await expect(row('Costly')).toContainText('$0.50');
  await expect(row('Costly')).toContainText('CST · 1 session · 2 items');
  await row('Costly').getByRole('link').click();
  await expect(page).toHaveURL(/\/p\/CST\/costs$/);

  await page.request.post(`/api/sessions/${s.id}/stop`);
});
