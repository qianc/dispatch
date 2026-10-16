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

  // a new item is written in the side panel too, and opens there once created
  await page.getByRole('button', { name: 'New item' }).click();
  const form = page.getByRole('complementary', { name: 'New item' });
  await form.getByLabel('Title').fill('Made in the panel');
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(drawer.getByRole('heading', { name: 'Made in the panel' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: /Made in the panel/ })).toBeVisible();
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
  // on hold: its own group above Closed
  await page.getByRole('button', { name: /Status: In progress/ }).click();
  await page.getByRole('dialog', { name: 'Status' }).getByRole('button', { name: /On hold/ }).click();
  await expect(page.getByRole('button', { name: /Status: On hold/ })).toBeVisible();
  await page.goto('/p/STS');
  await expect(page.getByText('On hold · 1')).toBeVisible();
  await expect(page.getByText('Status item')).toBeVisible();
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
  // the finished turn's tool calls fold into one line; the answer stays out
  const fold = page.getByRole('button', { name: /Worked · 1 step/ });
  await expect(fold).toBeVisible();
  await expect(page.getByText('npm test')).toHaveCount(0);
  await fold.click();
  await expect(page.getByText('npm test')).toBeVisible();

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

test.describe('with a keyboard and mouse', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

test('desktop: Discuss opens beside the item, on its page and in the drawer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'DIS', name: 'Discussing' } });
  const it = await (await page.request.post('/api/projects/DIS/items', { data: { title: 'Talk about me', body_md: 'The item body stays in view' } })).json();
  await page.request.post('/api/projects/DIS/items', { data: { title: 'Another one' } });

  // the item page: item left, chat right
  await page.goto(`/items/${it.id}`);
  await page.getByRole('button', { name: /Discuss this/ }).click();
  const panel = page.getByRole('complementary', { name: 'Discussion' });
  await panel.getByRole('button', { name: 'Explain this item in plain words' }).click();
  await expect(panel.getByText('(fake) About DIS-1: Talk about me')).toBeVisible();
  await expect(page.getByText('The item body stays in view')).toBeVisible();
  await expect(page).toHaveURL(/discuss=1/);
  await page.reload();
  await expect(panel.getByText('(fake) About DIS-1: Talk about me')).toBeVisible();
  await panel.getByRole('button', { name: 'Close chat' }).click();
  await expect(panel).toHaveCount(0);

  // the drawer: item | chat, with the list still there
  await page.goto('/p/DIS');
  await page.getByRole('main').getByRole('link', { name: /Talk about me/ }).click();
  await page.getByRole('complementary', { name: 'Item' }).getByRole('button', { name: /Discuss this/ }).click();
  await expect(panel.getByText('(fake) About DIS-1: Talk about me')).toBeVisible();
  await expect(page.getByText('The item body stays in view')).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: /Another one/ })).toBeVisible();

  // narrower: the chat takes the drawer, closing it goes back to the item
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.getByText('(fake) About DIS-1: Talk about me')).toBeVisible();
  await expect(page.getByText('The item body stays in view')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close chat' }).click();
  await expect(page.getByText('The item body stays in view')).toBeVisible();
});

test('desktop chat box: grows with its lines; Enter sends, Shift+Enter adds a line', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'KEY', name: 'Keys' } });
  await page.request.post('/api/projects/KEY/repos', { data: { github_owner: 'me', github_name: 'keys' } });
  const it = await (await page.request.post('/api/projects/KEY/items', { data: { title: 'Keys item' } })).json();
  const s = await (await page.request.post('/api/projects/KEY/batches', { data: { item_ids: [it.id], prompt: '', force_plan: false } })).json();
  await page.goto(`/s/${s.id}`);
  await page.getByRole('button', { name: /Refactor/ }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByText('(fake) Done with "Refactor"')).toBeVisible();

  const box = page.getByLabel('Message');
  const h1 = (await box.boundingBox())!.height;
  await box.click();
  await page.keyboard.type('first line');
  for (const l of ['second', 'third', 'fourth']) {
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(l);
  }
  await expect(box).toHaveValue('first line\nsecond\nthird\nfourth');
  expect((await box.boundingBox())!.height).toBeGreaterThan(h1 * 2);
  await page.keyboard.press('Enter');
  await expect(page.getByText('(fake) You said: first line')).toBeVisible();
  await expect(box).toHaveValue('');
  // back to one line
  expect((await box.boundingBox())!.height).toBeLessThan(h1 + 4);
  await box.fill('with control');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText('(fake) You said: with control')).toBeVisible();
});
});

test('phone chat box: Enter adds a line, the button sends', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Assistant' }).click();
  const box = page.getByLabel('Message');
  await box.click();
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await expect(box).toHaveValue('one\ntwo');
});

test('images on an item: add, view full size, delete', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'PIC', name: 'Pictures' } });
  const it = await (await page.request.post('/api/projects/PIC/items', { data: { title: 'Legend overlaps' } })).json();
  await page.goto(`/items/${it.id}`);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.locator('input[type=file]').setInputFiles({ name: 'overlap.png', mimeType: 'image/png', buffer: png });
  const thumb = page.getByRole('button', { name: 'Show image overlap.png' });
  await expect(thumb).toBeVisible();
  await thumb.click();
  const box = page.getByRole('dialog', { name: 'Image' });
  await expect(box.getByText('overlap.png · you')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await box.getByRole('button', { name: 'Delete' }).click();
  await expect(thumb).toHaveCount(0);
  // a file that is not an image is refused, with the reason
  await page.locator('input[type=file]').setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not really a png file') });
  await expect(page.getByText('Only PNG, JPEG, GIF and WebP images can be attached.')).toBeVisible();
});
