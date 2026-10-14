import { expect, test } from '@playwright/test';

test('phone flow: project → items → batch → answer → planner card → start', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();

  // project with a custom effort scale
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('button', { name: '+ New' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Homecontrol');
  await dialog.getByLabel('Key').fill('HC');
  await dialog.getByLabel('Effort scale').fill('1, 2, 3, 5, 8');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Homecontrol' })).toBeVisible();

  // repo
  await page.getByRole('radio', { name: 'Settings' }).click();
  await page.getByLabel('Repository').fill('me/homecontrol');
  await page.getByRole('button', { name: 'Add repo' }).click();
  await expect(page.getByText('me/homecontrol')).toBeVisible();

  // two backlog items
  await page.getByRole('radio', { name: 'Backlog' }).click();
  for (const [title, effort] of [['Energy price chart', '5'], ['Dark mode', '2']]) {
    await page.getByRole('button', { name: 'New item' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Title').fill(title);
    await d.getByRole('radio', { name: 'High', exact: true }).click();
    await d.getByRole('radio', { name: effort, exact: true }).click();
    await d.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText(title)).toBeVisible();
  }

  // checkboxes are hidden until Select; mark both and start a batch with plan-first
  await expect(page.getByRole('button', { name: 'Mark HC-1 for the agent' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Mark HC-1 for the agent' }).click();
  await page.getByRole('button', { name: 'Mark HC-2 for the agent' }).click();
  await expect(page.getByText('2 marked for the agent')).toBeVisible();
  await page.getByRole('button', { name: 'Start batch' }).click();
  await page.getByRole('dialog').getByLabel(/Plan first/).check();
  await page.getByRole('dialog').getByRole('radio', { name: 'Opus' }).click();
  await page.getByRole('dialog').getByRole('radio', { name: 'No subagents' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByText('Opus · no subagents')).toBeVisible();

  // plan approval, then the question
  await expect(page.getByText('Plan for approval')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Which approach should I take?')).toBeVisible();
  await page.getByRole('button', { name: /Refactor/ }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByText('(fake) Done with "Refactor"')).toBeVisible();
  await expect(page.getByText('Your turn')).toBeVisible();

  // follow-up message
  await page.getByLabel('Message').fill('looks good');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('(fake) You said: looks good')).toBeVisible();

  // inbox shows it, with a badge
  await page.getByRole('link', { name: /Inbox/ }).click();
  await expect(page.getByText('Your turn').first()).toBeVisible();

  // planner chat proposes a batch; start it from the card
  await page.goto('/p/HC');
  await page.getByRole('button', { name: 'Plan with Claude' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start planning chat' }).click();
  await expect(page.getByText('Proposed batch')).toBeVisible();
  await page.getByRole('button', { name: /Start batch/ }).click();
  await expect(page.getByText('Which approach should I take?')).toBeVisible();
});

test('retro capture and split into linked items', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: /Homecontrol/ }).click();
  await page.getByRole('radio', { name: 'Sources' }).click();
  await page.getByRole('button', { name: /Capture retro/ }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Title').fill('Slideshow skill retro');
  await d.getByLabel('Reporter').fill('alex');
  await d.getByLabel('Version tag').fill('v6.4.1');
  await d.getByLabel(/Retro \/ report text/).fill('- fonts wrong in Edge\n- slow export');
  await d.getByRole('button', { name: 'Save source' }).click();
  await expect(page.getByText('v6.4.1')).toBeVisible();
  await page.getByRole('button', { name: 'Split into items with Claude' }).click();
  await expect(page.getByText('Proposed items')).toBeVisible();
  await page.getByRole('button', { name: /Create 2 items/ }).click();
  await expect(page.getByText(/Created HC-\d+, HC-\d+/)).toBeVisible();
  await page.getByRole('link', { name: /Source: Slideshow/ }).click();
  await expect(page.getByText('Items from this source · 2')).toBeVisible();
});

test('assistant creates a project from a chat message', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Assistant' }).click();
  await page.getByLabel('Message').fill('create project Slides me/slides');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('link', { name: 'SLIDE', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Slides' })).toBeVisible();
  await page.getByRole('radio', { name: 'Settings' }).click();
  await expect(page.getByText('me/slides')).toBeVisible();
  // the thread is still there when coming back
  await page.getByRole('link', { name: 'Assistant' }).click();
  await expect(page.getByText('create project Slides me/slides')).toBeVisible();
});

test('sheet buttons are not covered by the tab bar', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('button', { name: '+ New' }).click();
  const create = page.getByRole('dialog').getByRole('button', { name: 'Create project' });
  await create.scrollIntoViewIfNeeded();
  const box = (await create.boundingBox())!;
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  expect(hit).toBe('Create project');
});

test('tags and modules with suggestions, filters, and long-press select', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('button', { name: '+ New' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Tagged');
  await page.getByRole('dialog').getByLabel('Key').fill('TG');
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();

  const add = async (title: string, modules: string[], tags: string[], suggested?: string) => {
    await page.getByRole('button', { name: 'New item' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Title').fill(title);
    for (const m of modules) {
      await d.getByLabel('Add modules').fill(m);
      await d.getByLabel('Add modules').press('Enter');
    }
    if (suggested) await d.getByRole('button', { name: suggested, exact: true }).click(); // a suggestion from the project
    for (const t of tags) await d.getByLabel('Add tags').fill(`${t},`);
    await d.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText(title)).toBeVisible();
  };
  await add('Chart labels overlap', ['charts'], ['ux']);
  await add('Export is slow', ['export'], ['perf'], 'ux');
  await add('Waterfall chart', [], [], 'charts');

  // search
  await page.getByLabel('Search items').fill('export');
  await expect(page.getByText('1 of 3 shown')).toBeVisible();
  await page.getByLabel('Search items').fill('');

  // filter by module, then show full titles with tags
  await page.getByRole('button', { name: 'Filter and view' }).click();
  await page.getByRole('group', { name: 'Modules' }).getByRole('button', { name: /charts · 2/ }).click();
  await page.getByLabel('Show full titles, tags and modules').check();
  await page.getByRole('button', { name: /Show 2/ }).click();
  await expect(page.getByText('Export is slow')).toHaveCount(0);
  await expect(page.getByText('#ux')).toBeVisible();
  await page.getByRole('button', { name: 'Clear', exact: true }).first().click();

  // long press marks an item and enters select mode
  const row = page.getByRole('link', { name: /Export is slow/ });
  await row.dispatchEvent('pointerdown');
  await page.waitForTimeout(600);
  await row.dispatchEvent('pointerup');
  await expect(page.getByText('1 marked for the agent')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();
  // on a phone the key shows as its number
  await expect(page.getByLabel('TG-2', { exact: true })).toHaveText('2');
});

test('item links open files, images and other items; Discuss this chats about the item', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // seed through the API with the browser's cookie
  const api = (path: string, data: unknown) => page.request.post(`/api${path}`, { data });
  await api('/projects', { key: 'LNK', name: 'Links' });
  const src = await (await api('/projects/LNK/sources', { kind: 'manual', title: '/tmp/dispatch-e2e-src/backlog.md', body_md: 'x' })).json();
  await api('/projects/LNK/items', { title: 'B9 — The plan builds the deck' });
  const item = await (await api('/projects/LNK/items', {
    title: 'X1 — Linked item', source_id: src.id,
    body_md: 'Read [the triage](docs/triage.md) and see [B9](#b9--the-plan-builds-the-deck).',
  })).json();

  await page.goto(`/items/${item.id}`);
  await page.getByRole('link', { name: 'the triage' }).click();
  await expect(page.getByRole('heading', { name: 'Triage notes' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'diagram' })).toHaveJSProperty('naturalWidth', 1);
  await page.getByRole('link', { name: 'the pic' }).click();
  await expect(page.getByRole('img', { name: 'pic.png' })).toHaveJSProperty('naturalWidth', 1);

  await page.goto(`/items/${item.id}`);
  await page.getByRole('link', { name: 'B9', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'B9 — The plan builds the deck' })).toBeVisible();

  await page.goto(`/items/${item.id}`);
  await page.getByRole('link', { name: /Discuss this/ }).click();
  await page.getByRole('button', { name: 'Explain this item in plain words' }).click();
  await expect(page.getByText('(fake) About LNK-2: X1 — Linked item')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Discuss LNK-2' })).toBeVisible();
});

test('tabs return to where you were; back keeps the list scrolled', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await page.request.post('/api/projects', { data: { key: 'SCR', name: 'Scroll' } });
  for (let i = 1; i <= 40; i++) await page.request.post('/api/projects/SCR/items', { data: { title: `Item number ${i}` } });

  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: /Scroll/ }).click();
  await expect(page.getByText('Item number 40')).toBeVisible();
  const area = page.locator('main.scroll-area');
  await area.evaluate((el) => (el.scrollTop = 900));
  await page.waitForTimeout(300);

  // open an item deep in the list, then back: same scroll position
  // (Playwright scrolls a row into view before clicking it, so read the position after that)
  const row = page.getByText('Item number 10', { exact: true });
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const before = await area.evaluate((el) => el.scrollTop);
  await row.click();
  await expect(page.getByRole('heading', { name: 'Item number 10' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByText('Item number 10', { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  expect(Math.abs((await area.evaluate((el) => el.scrollTop)) - before)).toBeLessThan(5);

  // another tab and back: the project, not the project list
  await page.getByRole('link', { name: 'Assistant' }).click();
  await expect(page.getByRole('heading', { name: 'Assistant' })).toBeVisible();
  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page).toHaveURL(/\/p\/SCR/);
  await page.waitForTimeout(300);
  expect(Math.abs((await area.evaluate((el) => el.scrollTop)) - before)).toBeLessThan(5);
  // tapping the tab you are in goes to its top
  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test('images Claude reads show as thumbnails that open full size', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await page.request.post('/api/projects', { data: { key: 'IMG', name: 'Images' } });
  await page.request.post('/api/projects/IMG/repos', { data: { github_owner: 'me', github_name: 'img' } });
  const s = await (await page.request.post('/api/projects/IMG/batches', { data: { prompt: 'go' } })).json();
  await page.goto(`/s/${s.id}`);
  await page.getByRole('button', { name: /Small fix/ }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByText('Your turn')).toBeVisible();
  await page.getByLabel('Message').fill('show me the image');
  await page.getByRole('button', { name: 'Send' }).click();
  const thumb = page.getByRole('button', { name: 'Show image' });
  await expect(thumb.locator('img')).toHaveJSProperty('naturalWidth', 1);
  await thumb.click();
  await expect(page.getByRole('dialog', { name: 'Image' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog', { name: 'Image' })).toHaveCount(0);
});
