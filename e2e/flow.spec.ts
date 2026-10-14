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
  await page.getByRole('dialog').getByRole('button', { name: 'Start session' }).click();

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
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: /Homecontrol/ }).click();
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
