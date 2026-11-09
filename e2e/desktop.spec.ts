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
  await expect(menu.getByRole('link', { name: 'Desktop' })).toBeVisible();

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

test('sort button: orders the filtered list and keeps the choice per project (DISP-49)', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'SRT', name: 'Sorted' } });
  await page.request.post('/api/projects', { data: { key: 'SRU', name: 'Sorted too' } });
  await page.request.post('/api/projects/SRT/items', { data: { title: 'Alpha low large', importance: 1, effort: 4 } });
  await page.request.post('/api/projects/SRT/items', { data: { title: 'Bravo high small', importance: 3, effort: 0 } });
  await page.request.post('/api/projects/SRT/items', { data: { title: 'Charlie medium unsized', importance: 2 } });
  await page.request.post('/api/projects/SRT/items', { data: { title: 'Delta critical other', importance: 4, effort: 2, labels: ['other'] } });
  await page.goto('/p/SRT');

  const titles = () => page.getByRole('main').getByRole('link').filter({ hasText: /Alpha|Bravo|Charlie|Delta/ });
  const expectOrder = (...names: string[]) => expect(titles()).toHaveText(names.map((n) => new RegExp(n)));
  const sortBy = async (choice: string) => {
    await page.getByRole('button', { name: /^Sort:/ }).click();
    await page.getByRole('dialog', { name: 'Sort' }).getByRole('button', { name: choice }).click();
    await expect(page.getByRole('dialog', { name: 'Sort' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Sort: ${choice}` })).toBeVisible();
  };

  // the default, shown on the button next to Filter
  const sortButton = page.getByRole('button', { name: 'Sort: Most severe first' });
  await expect(sortButton).toHaveText('Most severe');
  await expectOrder('Delta', 'Bravo', 'Charlie', 'Alpha');
  const filterBox = (await page.getByRole('button', { name: 'Filter and view' }).boundingBox())!;
  expect((await sortButton.boundingBox())!.x).toBeGreaterThan(filterBox.x);

  await sortBy('Least severe first');
  await expectOrder('Alpha', 'Charlie', 'Bravo', 'Delta');
  await sortBy('Smallest first');
  await expectOrder('Bravo', 'Delta', 'Alpha', 'Charlie'); // no size: last
  await sortBy('Largest first');
  await expectOrder('Alpha', 'Delta', 'Bravo', 'Charlie'); // no size: still last
  await sortBy('Oldest first');
  await expectOrder('Alpha', 'Bravo', 'Charlie', 'Delta');
  await sortBy('Newest first');
  await expectOrder('Delta', 'Charlie', 'Bravo', 'Alpha');

  // a filtered list is sorted too, and clearing the filter keeps the sort
  await page.getByLabel('Search items').fill('c');
  await expectOrder('Delta', 'Charlie');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expectOrder('Delta', 'Charlie', 'Bravo', 'Alpha');
  await expect(page.getByRole('button', { name: 'Sort: Newest first' })).toBeVisible();

  // kept after leaving and returning
  await page.goto('/projects');
  await page.getByRole('link', { name: /^Sorted\b(?! too)/ }).first().click();
  await expect(page.getByRole('button', { name: 'Sort: Newest first' })).toBeVisible();
  await expectOrder('Delta', 'Charlie', 'Bravo', 'Alpha');

  // the toolbar still fits on a phone, with the longest label and the Select button
  await sortBy('Most severe first');
  await expect(page.getByLabel('Search items')).toBeVisible();
  expect((await page.getByLabel('Search items').boundingBox())!.width).toBeGreaterThan(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await sortBy('Oldest first');

  // each project keeps its own: moving between projects in the same page does not carry it over
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/p/SRU');
  const menu = page.getByRole('complementary', { name: 'Menu' });
  await expect(page.getByRole('button', { name: 'Sort: Most severe first' })).toBeVisible();
  await menu.getByRole('link', { name: 'Sorted', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sort: Oldest first' })).toBeVisible();
  await menu.getByRole('link', { name: 'Sorted too', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sort: Most severe first' })).toBeVisible();
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

test('inbox: a planning chat with an open proposal offers its actions, not Mark as complete', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'PLN', name: 'Planning' } });
  await page.request.post('/api/projects/PLN/repos', { data: { github_owner: 'me', github_name: 'pln' } });
  for (const title of ['Plan one', 'Plan two']) await page.request.post('/api/projects/PLN/items', { data: { title } });
  const planCard = async () => {
    const s = await (await page.request.post('/api/projects/PLN/planner', { data: { prompt: '' } })).json();
    await page.goto('/');
    const card = page.locator('div.rounded-xl').filter({ hasText: 'Claude proposes a batch' }).filter({ has: page.locator(`a[href="/s/${s.id}"]`) });
    await expect(card).toBeVisible({ timeout: 20_000 });
    return { s, card };
  };
  const status = async (id: number) => (await (await page.request.get(`/api/sessions/${id}`)).json()).session.status;

  // dismiss: closes the card and the planning chat
  const first = await planCard();
  await expect(first.card.getByRole('button', { name: 'Start batch (2)' })).toBeVisible();
  await expect(first.card.getByRole('link', { name: 'Open to edit' })).toHaveAttribute('href', `/s/${first.s.id}`);
  await expect(first.card.getByRole('button', { name: 'Mark as complete' })).toHaveCount(0);
  await first.card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(first.card).toHaveCount(0);
  await expect.poll(() => status(first.s.id)).toBe('completed');

  // start: the batch starts as proposed and opens, like Start on the card in the chat
  const second = await planCard();
  await second.card.getByRole('button', { name: 'Start batch (2)' }).click();
  await expect(page).not.toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Session actions' })).toBeVisible();
  await expect.poll(() => status(second.s.id)).toBe('completed');
  // free the worker slot for the other tests
  const started = page.url().match(/\/s\/(\d+)/)![1];
  await page.request.post(`/api/sessions/${started}/finish`, { data: { status: 'stopped' } });
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
  // zoom inside the viewer: double-tap in and out, wheel; a tap while zoomed keeps it open
  const img = box.locator('img');
  const vb = (await img.boundingBox())!;
  const mid = { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 }; // where a finger would tap
  await expect(img).toHaveAttribute('data-zoom', '1.00');
  await page.mouse.dblclick(mid.x, mid.y);
  await expect(img).toHaveAttribute('data-zoom', '2.50');
  await page.waitForTimeout(350);
  await page.mouse.click(mid.x, mid.y);
  await expect(box).toBeVisible();
  await page.waitForTimeout(350);
  await page.mouse.dblclick(mid.x, mid.y);
  await expect(img).toHaveAttribute('data-zoom', '1.00');
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => Number(await img.getAttribute('data-zoom'))).toBeGreaterThan(1.2);
  page.once('dialog', (d) => d.accept());
  await box.getByRole('button', { name: 'Delete' }).click();
  await expect(thumb).toHaveCount(0);
  // a file that is not an image is refused, with the reason
  await page.locator('input[type=file]').setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not really a png file') });
  await expect(page.getByText('Only PNG, JPEG, GIF and WebP images can be attached.')).toBeVisible();
});

/** What the iOS keyboard does: the visible area (visualViewport) shrinks; with `layout` the layout
 * viewport (innerHeight) shrinks with it, as interactive-widget=resizes-content does. */
async function keyboard(page: Page, h: number | null, { layout = false, event = true } = {}) {
  await page.evaluate(({ h, layout, event }) => {
    const vv = window.visualViewport!;
    const w = window as unknown as { __fullH?: number };
    w.__fullH ??= window.innerHeight;
    const full = w.__fullH;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => h ?? full });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => (layout && h ? h : full) });
    if (event) vv.dispatchEvent(new Event('resize'));
  }, { h, layout, event });
}
const kbOpen = (page: Page) => page.evaluate(() => document.documentElement.classList.contains('kb-open'));

test('phone: a sheet stays above the keyboard, with the field you type in visible', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'KBD', name: 'Keyboard' } });
  await page.goto('/p/KBD');
  await page.getByRole('button', { name: 'Plan with Claude' }).click();
  const field = page.getByRole('dialog').locator('textarea');
  await field.click();
  await keyboard(page, 420);
  await field.fill('quick wins before the release');
  await expect.poll(() => kbOpen(page)).toBe(true);
  const fieldBox = (await field.boundingBox())!;
  const sheetBox = (await page.getByRole('dialog').locator('> div.relative').boundingBox())!;
  expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(421);
  expect(fieldBox.y + fieldBox.height).toBeLessThanOrEqual(421);
  expect(fieldBox.y).toBeGreaterThanOrEqual(0);
});

test('phone: the tab bar hides while the keyboard is up, and the page keeps its full height without it', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'KBN', name: 'Keyboard nav' } });
  const it = await (await page.request.post('/api/projects/KBN/items', { data: { title: 'Type here' } })).json();
  await page.goto(`/items/${it.id}/discuss`);
  const tabs = page.getByRole('navigation', { name: 'Main' });
  const field = page.getByLabel('Message');
  const full = page.viewportSize()!.height;
  const appH = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--app-h'));

  // the keyboard opens as you tap the field
  await field.click();
  await keyboard(page, 400);
  await expect(tabs).toBeHidden();
  expect(await appH()).toBe('400px');
  // the keyboard closes
  await field.blur();
  await keyboard(page, null);
  await expect(tabs).toBeVisible();
  expect(await appH()).toBe(`${full}px`);

  // the layout viewport shrinks along with the keyboard (interactive-widget=resizes-content)
  await field.click();
  await keyboard(page, 400, { layout: true });
  await expect(tabs).toBeHidden();
  await field.blur();
  await keyboard(page, null);
  await expect(tabs).toBeVisible();

  // the viewport shrank before the field had focus, and no resize follows the focus
  await keyboard(page, 400, { event: false });
  await field.focus();
  await expect(tabs).toBeHidden();
  expect(await appH()).toBe('400px');

  // back from another app that had its keyboard up: the viewport still reports it shrunk, but no
  // field of ours has focus, so the page keeps its full height and the tab bar shows
  await field.blur();
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(tabs).toBeVisible();
  await expect.poll(appH).toBe(`${full}px`);

  // back with our own field focused and the keyboard up: tab bar hidden
  await field.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(tabs).toBeHidden();
});

test('projects get a colour and an icon, shown in the list', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'LOOK', name: 'Looks' } });
  await page.goto('/p/LOOK?tab=settings');
  await page.getByRole('radio', { name: 'teal' }).click();
  await page.getByRole('radio', { name: 'slides' }).click();
  await expect(page.getByRole('radio', { name: 'slides' })).toHaveAttribute('aria-checked', 'true');
  const p = await (await page.request.get('/api/projects/LOOK')).json();
  expect(p).toMatchObject({ color: 'teal', icon: 'slides' });
  // a name that is not on the list is refused
  expect((await page.request.patch('/api/projects/LOOK', { data: { color: 'chartreuse' } })).status()).toBe(400);
  await page.getByRole('link', { name: 'Projects' }).click();
  const row = page.getByRole('link', { name: /Looks/ });
  await expect(row.locator('span[aria-hidden] svg')).toBeVisible();
  await expect(row.getByText('LOOK', { exact: true })).toHaveCSS('color', 'rgb(20, 184, 166)');
});

test('Discuss suggests a change to the item, and nothing changes until Apply', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'SUG', name: 'Suggestions' } });
  const it = await (await page.request.post('/api/projects/SUG/items', { data: { title: 'Voice rules' } })).json();
  await page.goto(`/items/${it.id}/discuss`);
  await page.getByLabel('Message').fill('Can you add this to the item?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Suggested change · SUG-1')).toBeVisible();
  await expect(page.getByText('Medium')).toBeVisible(); // old value, crossed out
  await expect(page.getByText('Design note:')).toBeVisible();
  expect((await (await page.request.get(`/api/items/${it.id}`)).json()).comments).toEqual([]);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText(/Applied to SUG-1: 2 changes and a comment/)).toBeVisible();
  const after = await (await page.request.get(`/api/items/${it.id}`)).json();
  expect(after).toMatchObject({ importance: 3, labels: ['design'] });
  expect(after.comments[0]).toMatchObject({ author: 'claude' });
});

test('phone: Discuss shows the item above the chat, long text shortened', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'RD', name: 'Reading' } });
  const body = `Start of the description.\n\n${'A long middle paragraph about the voice rules. '.repeat(20)}\n\nThe last line of the description.`;
  const it = await (await page.request.post('/api/projects/RD/items', { data: { title: 'Read me first', body_md: body } })).json();
  await page.goto(`/items/${it.id}/discuss`);
  const intro = page.getByLabel('The item');
  await expect(intro.getByRole('heading', { name: 'Read me first' })).toBeVisible();
  await expect(intro.getByText('Start of the description.')).toBeVisible();
  await expect(intro.getByText('The last line of the description.')).not.toBeInViewport();
  await intro.getByRole('button', { name: 'Show all' }).click();
  await intro.getByText('The last line of the description.').scrollIntoViewIfNeeded();
  await expect(intro.getByText('The last line of the description.')).toBeInViewport();
  // still there once the chat has started
  await page.getByLabel('Message').fill('what is this?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('(fake) About RD-1')).toBeVisible();
  await expect(page.getByLabel('The item').getByRole('heading', { name: 'Read me first' })).toBeAttached();
});

test('phone: a long unbroken title wraps instead of making the page scroll sideways', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'WRAP', name: 'Wrapping' } });
  const title = 'Fix the flaky TestRestartDoesNotInstallAVersionANewerOneHasReplacedAlreadyWhenTheUpdaterRigRestarts';
  const it = await (await page.request.post('/api/projects/WRAP/items', { data: { title, body_md: '## Context\n\n`internal/update/updater_test.go:909` fails' } })).json();
  const noSideways = () => page.evaluate(() => [...document.querySelectorAll('.scroll-area')].every((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).overflowX === 'hidden'));
  for (const path of [`/items/${it.id}`, `/items/${it.id}/discuss`]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    const h = (await page.getByRole('heading', { name: title }).boundingBox())!;
    expect(h.x + h.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await noSideways()).toBe(true);
  }
});

async function plannerWithCard(page: Page, key: string) {
  await page.request.post('/api/projects', { data: { key, name: `Peek ${key}` } });
  for (const title of ['Price alerts', 'Tariff import']) await page.request.post(`/api/projects/${key}/items`, { data: { title, body_md: `About ${title}.` } });
  const s = await (await page.request.post(`/api/projects/${key}/planner`, { data: { prompt: '' } })).json();
  await page.goto(`/s/${s.id}`);
  await expect(page.getByText('Proposed batch')).toBeVisible();
  return s.id as number;
}

test('desktop: an item key in a proposal card opens the item beside the chat (DISP-3)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  await plannerWithCard(page, 'PKD');
  await page.getByRole('button', { name: 'Show PKD-1' }).click();
  const panel = page.getByRole('complementary', { name: 'Item' });
  await expect(panel.getByRole('heading', { name: 'Price alerts' })).toBeVisible();
  await expect(panel.getByText('About Price alerts.')).toBeVisible();
  await expect(page).toHaveURL(/peek=\d+/);
  // the card stays, and the key did not pick or unpick the item
  await expect(page.getByText('Proposed batch')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Price alerts' })).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: 'Close item' }).click();
  await expect(panel).toHaveCount(0);
});

test('phone: an item key in a proposal card opens the item page, Back returns to the card (DISP-3)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 520 }); // a chat taller than the screen
  await login(page);
  const id = await plannerWithCard(page, 'PKM');
  await expect(page.getByRole('button', { name: /Start batch/ })).toBeVisible();
  // read a little further up the chat, so it is not just pinned to the newest message
  const area = page.locator('.scroll-area');
  await area.evaluate((el) => (el.scrollTop = el.scrollHeight - el.clientHeight - 150)); // more than near the bottom
  await expect(page.getByRole('button', { name: 'Show PKM-2' })).toBeInViewport();
  const scrolled = await area.evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  const cardTop = async () => (await page.getByText('Proposed batch').boundingBox())!.y;
  const before = await cardTop();
  await page.getByRole('button', { name: 'Show PKM-2' }).click();
  await expect(page).toHaveURL(/\/items\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Tariff import' })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${id}$`));
  await expect(page.getByText('Proposed batch')).toBeInViewport();
  await expect.poll(() => area.evaluate((el) => el.scrollTop)).toBe(scrolled);
  expect(Math.abs((await cardTop()) - before)).toBeLessThan(2);
});

test('a notification while the app is open shows in the page (DISP-12)', async ({ page }) => {
  await login(page);
  await page.goto('/settings'); // the test notice is about the inbox: on the inbox there is nothing to show
  const banner = page.getByRole('status', { name: 'Notification' });
  // the live stream may still be connecting: send until one arrives
  await expect(async () => {
    await page.request.post('/api/push/test');
    await expect(banner.getByText('Test notification')).toBeVisible({ timeout: 1000 });
  }).toPass();
  await banner.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(banner).toHaveCount(0);
});

test('project settings: inputs stand out from the page and Save is the primary action (DISP-48)', async ({ page }) => {
  await login(page);
  await page.request.post('/api/projects', { data: { key: 'LOK', name: 'Looks' } });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto('/p/LOK');
    await page.getByRole('radio', { name: 'Settings' }).click();
    const css = (l: import('@playwright/test').Locator, prop: string) => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
    const role = (name: string) => page.evaluate((n) => {
      const probe = document.body.appendChild(document.createElement('div'));
      probe.style.color = `var(--color-${n})`;
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    }, name);

    const name = page.getByLabel('Name', { exact: true });
    const pageBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await css(name, 'background-color')).not.toBe(pageBg);
    expect(await css(name, 'border-top-color')).toBe(await role('line-strong'));
    await name.focus();
    expect(await css(name, 'border-top-color')).toBe(await role('accent'));
    expect(await css(name, 'box-shadow')).not.toBe('none');

    const form = page.locator('form').filter({ has: name });
    expect(await css(form.getByRole('button', { name: 'Save' }), 'background-color')).toBe(await role('accent-strong'));
  }
});

test('desktop menu: the signed-in user and Log out at the bottom (DISP-64)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  const menu = page.getByRole('complementary', { name: 'Menu' });
  await expect(menu.getByText('owner', { exact: true })).toBeVisible();
  const logOut = menu.getByRole('button', { name: 'Log out' });
  await expect(logOut).toBeVisible();
  // below the navigation, at the foot of the menu
  const menuBox = (await menu.boundingBox())!;
  const linkBox = (await logOut.boundingBox())!;
  expect(linkBox.y).toBeGreaterThan((await menu.getByRole('link', { name: 'Settings' }).boundingBox())!.y);
  expect(menuBox.y + menuBox.height - (linkBox.y + linkBox.height)).toBeLessThan(40);

  // by keyboard: Tab reaches it, Enter signs out and shows the sign-in page
  await logOut.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(logOut).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Password')).toBeVisible();
  expect((await (await page.request.get('/api/me')).json()).authed).toBe(false);
});

test('desktop menu: a long name is cut short with the full name in its title; none on a phone (DISP-64)', async ({ page }) => {
  const long = 'someone.with.a.very.long.name@example-company.example.com';
  await page.route('**/api/me', async (route) => {
    const me = await (await route.fetch()).json();
    await route.fulfill({ json: { ...me, user: long } });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  const menu = page.getByRole('complementary', { name: 'Menu' });
  const name = menu.getByTitle(long);
  await expect(name).toHaveText(long);
  // fits the menu on one line, with Log out still beside it
  expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const nameBox = (await name.boundingBox())!;
  const linkBox = (await menu.getByRole('button', { name: 'Log out' }).boundingBox())!;
  expect(linkBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width);
  expect(Math.abs(linkBox.y + linkBox.height / 2 - (nameBox.y + nameBox.height / 2))).toBeLessThan(4);
  expect(linkBox.x + linkBox.width).toBeLessThanOrEqual((await menu.boundingBox())!.width);

  // on a phone there is no menu, so no name or link
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('complementary', { name: 'Menu' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
});

test('session: the prompt in the side panel, collapsed when long, each session its own (DISP-66)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  // earlier tests leave sessions in the menu's Running and Queued lists: stop them so ours are listed
  for (const old of await (await page.request.get('/api/sessions?status=queued,running,waiting_input,idle')).json()) {
    await page.request.post(`/api/sessions/${old.id}/finish`, { data: { status: 'stopped' } });
  }
  await page.request.post('/api/projects', { data: { key: 'PRM', name: 'Prompts' } });
  await page.request.post('/api/projects/PRM/repos', { data: { github_owner: 'me', github_name: 'prm' } });
  const long = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: check the login form in every browser we support`).join('\n');
  const a = await (await page.request.post('/api/projects/PRM/batches', { data: { title: 'Long prompt', prompt: long } })).json();
  const b = await (await page.request.post('/api/projects/PRM/batches', { data: { title: 'Short prompt', prompt: 'Just fix it' } })).json();

  await page.goto(`/s/${a.id}`);
  const panel = page.getByRole('complementary').filter({ hasText: 'Details' });
  const prompt = panel.getByRole('heading', { name: 'Prompt' });
  await expect(prompt).toBeVisible();
  expect((await prompt.boundingBox())!.y).toBeLessThan((await panel.getByRole('heading', { name: 'Details' }).boundingBox())!.y);
  await expect(panel.getByText(/Step 1:/)).toBeVisible();
  await expect(panel.getByText(/Step 12:/)).toHaveCount(0);
  await panel.getByRole('button', { name: 'Show more' }).click();
  await expect(panel.getByText(/Step 12:/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Show less' })).toBeVisible();

  // the other session: a short prompt, whole, nothing to expand
  const menu = page.getByRole('complementary', { name: 'Menu' });
  await menu.getByRole('link', { name: /Short prompt/ }).click();
  await expect(panel.getByText('Just fix it')).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Show (more|less)$/ })).toHaveCount(0);
  // back: the long prompt is still expanded
  await menu.getByRole('link', { name: /Long prompt/ }).click();
  await expect(panel.getByText(/Step 12:/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Show less' })).toBeVisible();
});

test('desktop menu: no name and no Log out when sign-in is off (DISP-64)', async ({ page }) => {
  await page.route('**/api/me', async (route) => {
    const me = await (await route.fetch()).json();
    await route.fulfill({ json: { ...me, auth_mode: 'off', auth_disabled: true } });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  const menu = page.getByRole('complementary', { name: 'Menu' });
  await expect(menu.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Log out' })).toHaveCount(0);
  await expect(menu.getByText('owner', { exact: true })).toHaveCount(0);
  // the same as Settings, which hides its Sign out
  await menu.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});
