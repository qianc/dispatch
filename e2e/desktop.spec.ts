import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
}

test('desktop: left menu, checkboxes always on, items open in a drawer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'DSK', name: 'Desktop' } });
  await page.request.post('/api/projects/DSK/items', { data: { title: 'Wide layout', body_md: 'Body of the wide item' } });
  await page.request.post('/api/projects/DSK/items', { data: { title: 'Second thing' } });

  // the tab bar is a left menu
  const menu = page.getByRole('complementary', { name: 'Menu' });
  await expect(menu).toBeVisible();
  await menu.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: /Desktop/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Desktop' })).toBeVisible();
  // ...and lists the project as recent
  await expect(menu.getByRole('link', { name: /DSK/ })).toBeVisible();

  // checkboxes without a Select button
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark DSK-2 for the agent' }).click();
  await expect(page.getByText('1 marked for the agent')).toBeVisible();

  // clicking the title opens the item beside the list
  await page.getByRole('link', { name: /Wide layout/ }).click();
  const drawer = page.getByRole('complementary', { name: 'Item' });
  await expect(drawer.getByText('Body of the wide item')).toBeVisible();
  await expect(page).toHaveURL(/item=\d+/);
  await expect(page.getByRole('link', { name: /Second thing/ })).toBeVisible(); // list still there
  await drawer.getByRole('button', { name: 'Close item' }).click();
  await expect(drawer).toHaveCount(0);
});

test('phone: in select mode a tap on the text opens the item, the checkbox marks it', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'SEL', name: 'Selecting' } });
  await page.request.post('/api/projects/SEL/items', { data: { title: 'Open me' } });
  await page.goto('/p/SEL');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Mark SEL-1 for the agent' }).click();
  await expect(page.getByText('1 marked for the agent')).toBeVisible();
  await page.getByRole('link', { name: /Open me/ }).click();
  await expect(page.getByRole('heading', { name: 'SEL-1' })).toBeVisible();
  // no left menu on a phone
  await expect(page.getByRole('complementary', { name: 'Menu' })).toHaveCount(0);
});

test('item status shows as an icon with a picker', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'STS', name: 'Status' } });
  const it = await (await page.request.post('/api/projects/STS/items', { data: { title: 'Status item' } })).json();
  await page.goto(`/items/${it.id}`);
  await page.getByRole('button', { name: /Status: Backlog/ }).click();
  await page.getByRole('dialog', { name: 'Status' }).getByRole('button', { name: /In progress/ }).click();
  await expect(page.getByRole('button', { name: /Status: In progress/ })).toBeVisible();
});

test('inbox: a finished turn says what it needs and can be marked complete', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'TRN', name: 'Turns' } });
  await page.request.post('/api/projects/TRN/repos', { data: { github_owner: 'me', github_name: 'trn' } });
  const it = await (await page.request.post('/api/projects/TRN/items', { data: { title: 'Turn work' } })).json();
  const s = await (await page.request.post('/api/projects/TRN/batches', { data: { item_ids: [it.id], prompt: '', force_plan: false } })).json();
  // the fake runner asks a question first
  await page.goto(`/s/${s.id}`);
  await page.getByRole('button', { name: /Refactor/ }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByText('(fake) Done with "Refactor"')).toBeVisible();

  await page.getByRole('link', { name: /waiting Inbox/ }).click();
  const card = page.locator('div.rounded-xl', { hasText: 'Turn work' });
  await expect(card.getByText('Claude finished its turn and waits for your reply.')).toBeVisible();
  await card.getByRole('button', { name: 'Mark as complete' }).click();
  await expect(page.getByText('Turn work')).toHaveCount(0);
});

test('appearance: light, dark and auto', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('radio', { name: 'Auto' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
});
