import { expect, test, type Page } from '@playwright/test';

// DISP-81: a failed session shows in Needs you with its reason, and offers Mark as ignored, What
// would fix the issue? and Retry, on the phone and on desktop.

const REASON = 'GitHub is not signed in on this worker';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
}

/** A batch the fake worker fails at once, as with a lapsed GitHub login. */
async function failingBatch(page: Page, key: string, title: string) {
  await page.request.post('/api/projects', { data: { key, name: `Failures ${key}` } });
  await page.request.post(`/api/projects/${key}/repos`, { data: { github_owner: 'me', github_name: key.toLowerCase() } });
  const s = await (await page.request.post(`/api/projects/${key}/batches`, { data: { title, prompt: '[fake:fail] push the branch' } })).json();
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${s.id}`)).json()).session.status).toBe('failed');
  return s as { id: number };
}

const actions = (page: Page) => page.getByRole('group', { name: 'Failed session actions' });

test('phone: a failed session is in the Inbox; ask what would fix it, retry, ignore', async ({ page }) => {
  await login(page);
  const s = await failingBatch(page, 'FLP', 'Phone failure');

  // the Inbox: its reason and its buttons
  await page.goto('/');
  const card = page.locator('div.rounded-xl', { hasText: 'Phone failure' });
  await expect(card.getByText(REASON)).toBeVisible();
  await expect(card.getByRole('button', { name: "I've fixed it, please retry" })).toBeVisible();

  // the session page: the three buttons, in order
  await page.goto(`/s/${s.id}`);
  await expect(page.getByText(`Failed: ${REASON}`)).toBeVisible();
  await expect(actions(page).getByRole('button')).toHaveText(['Mark as ignored', 'What would fix the issue?', "I've fixed it, please retry"]);

  // a discussion seeded with the error; the failed session does not run again
  await actions(page).getByRole('button', { name: 'What would fix the issue?' }).click();
  await expect(page).not.toHaveURL(new RegExp(`/s/${s.id}$`));
  await expect(page.getByText(`Session #${s.id} "Phone failure"`).first()).toBeVisible();
  await expect(page.getByText('(fake) About the failed session.')).toBeVisible();
  expect((await (await page.request.get(`/api/sessions/${s.id}`)).json()).session.status).toBe('failed');

  // retry: a new session, linked to the failed one; it fails again and needs you with its own reason
  await page.goto(`/s/${s.id}`);
  await actions(page).getByRole('button', { name: "I've fixed it, please retry" }).click();
  await expect(page).not.toHaveURL(new RegExp(`/s/${s.id}$`));
  await expect(page.getByRole('link', { name: `retry of #${s.id}` })).toBeVisible();
  await expect(page.getByText(`Failed: ${REASON}`)).toBeVisible();
  const retryId = Number(page.url().split('/').pop());
  const failed = (await (await page.request.get('/api/inbox')).json()).failed.map((x: { id: number }) => x.id);
  expect(failed).toContain(retryId);
  expect(failed).not.toContain(s.id);

  // the first one says where it went
  await page.goto(`/s/${s.id}`);
  await expect(page.getByRole('link', { name: `#${retryId}` })).toBeVisible();
  await expect(actions(page)).toHaveCount(0);

  // ignore the retry: it leaves the Inbox, and can be shown again
  await page.goto(`/s/${retryId}`);
  await actions(page).getByRole('button', { name: 'Mark as ignored' }).click();
  await expect(actions(page).getByRole('button', { name: 'Show in Needs you again' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByText('Phone failure')).toHaveCount(0);
});

test('desktop: a failed session is in the menu\'s Needs you and Activity\'s Failed section, with its actions in the side panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  const s = await failingBatch(page, 'FLD', 'Desktop failure');

  const menu = page.getByRole('complementary', { name: 'Menu' });
  const entry = menu.getByRole('link', { name: /Desktop failure/ });
  await expect(entry).toBeVisible();
  await expect(entry).toContainText(REASON);

  await menu.getByRole('link', { name: 'Activity' }).click();
  const section = page.locator('section', { has: page.getByRole('heading', { name: /^Failed \(/ }) });
  await expect(section.getByRole('link', { name: /Desktop failure/ })).toContainText(REASON);

  await entry.click();
  const panel = page.getByRole('complementary').filter({ hasText: 'Details' });
  await expect(panel.getByText(REASON)).toBeVisible();
  await expect(panel.getByRole('group', { name: 'Failed session actions' }).getByRole('button')).toHaveText(['Mark as ignored', 'What would fix the issue?', "I've fixed it, please retry"]);
  // once: in the panel, not also in the chat
  await expect(actions(page)).toHaveCount(1);

  await panel.getByRole('button', { name: 'Mark as ignored' }).click();
  await expect(menu.getByRole('link', { name: /Desktop failure/ })).toHaveCount(0);
  await menu.getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByRole('heading', { name: 'Recently finished' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Desktop failure/ })).toBeVisible(); // in history
  expect((await (await page.request.get(`/api/sessions/${s.id}`)).json()).session).toMatchObject({ status: 'failed', closed_reason: 'ignored' });
});
