import { expect, test } from './fixtures.ts';

test('orchestration: start one, approve the plan, see the first step run', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();

  // a project with a repo and one open item (from the page, as the app itself would)
  await page.evaluate(async () => {
    const post = (path: string, body: unknown) => fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
    });
    await post('/projects', { key: 'ORC', name: 'Orchestrated' });
    await post('/projects/ORC/repos', { github_owner: 'me', github_name: 'orchestrated' });
    await post('/projects/ORC/items', { title: 'Store the tokens', status: 'backlog' });
  });

  await page.getByRole('link', { name: 'Activity' }).click();
  await page.getByRole('button', { name: '+ New orchestration' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('button', { name: 'Say what it should reach.' })).toBeDisabled();
  await sheet.getByLabel('Goal').fill('Move sign-in to the new tokens');
  await sheet.getByRole('checkbox', { name: /ORC/ }).click();
  await sheet.getByRole('button', { name: 'Start planning' }).click();

  // its page: the fake orchestrator plans one step for the project, and waits for a yes
  const plan = page.getByRole('region', { name: 'Orchestration' });
  await expect(plan.getByText('(fake) ORC work')).toBeVisible();
  await expect(plan.getByText('Plan ready to approve')).toBeVisible();
  await expect(plan.getByText('0 of 1 steps')).toBeVisible();
  await plan.getByRole('button', { name: 'Approve plan' }).click();

  // approved: it starts the step as a batch, and the step links to that session
  await expect(plan.getByText('Running', { exact: true })).toBeVisible();
  await expect(plan.getByRole('img', { name: 'Running' })).toBeVisible();
  await expect(plan.getByText(/Waiting for #\d+/)).toBeVisible();
  // settings while it runs: a cost limit, shown next to what it cost
  await plan.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog');
  await settings.getByLabel('Cost limit in dollars').fill('20');
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(plan.getByText('of $20.00')).toBeVisible();
  await expect(page.getByText(/Settings changed by the owner: cost limit \$20\.00\./)).toBeVisible();
  // on a phone the header's actions wrap under the counts: every button is whole inside the card (DISP-97)
  const card = (await plan.boundingBox())!;
  for (const name of ['Pause', 'Stop', 'Settings']) {
    const box = (await plan.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(card.x);
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // at the newest message the plan is out of view: the header's Plan button is one tap up to it (DISP-100)
  const chat = page.locator('main.scroll-area');
  await chat.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(plan.getByText('0 of 1 steps')).not.toBeInViewport();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(plan.getByText('0 of 1 steps')).toBeInViewport();
  expect(await chat.evaluate((el) => el.scrollTop)).toBe(0);
  // the "•••" menu opens on a phone and also leads there
  await chat.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('dialog', { name: 'Session' }).getByRole('button', { name: 'Go to the plan' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(plan.getByText('0 of 1 steps')).toBeInViewport();

  await plan.getByRole('link', { name: /\(fake\) ORC work/ }).click();
  await expect(page.getByText(/Part of Move sign-in to the new tokens \(step 1 of 1\)/)).toBeVisible();
  // from the batch, one tap opens the orchestrator at its plan: from the header and from the menu (DISP-101)
  const batch = page.url();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page).toHaveURL(/\/s\/\d+#plan$/);
  await expect(plan.getByText('0 of 1 steps')).toBeInViewport();
  await page.goto(batch);
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('dialog', { name: 'Session' }).getByRole('button', { name: "Open the orchestrator's plan" }).click();
  await expect(page).toHaveURL(/\/s\/\d+#plan$/);
  await expect(plan.getByText('0 of 1 steps')).toBeInViewport();

  // Activity: the orchestrator's row shows its steps, and the batch says what it is part of
  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByLabel('0 of 1 steps done')).toBeVisible();
  // its batch is under it: shown at once when it needs you, else behind "1 session"
  const fold = page.getByText('1 session', { exact: true });
  if (await fold.count()) await fold.click();
  // under its orchestrator the row says its step and then its own latest text, not the goal again (DISP-99)
  const row = page.getByRole('link', { name: /\(fake\) ORC work/ });
  await expect(row.getByText('Step 1 of 1', { exact: true })).toBeVisible();
  await expect(row).not.toContainText('Move sign-in to the new tokens');
  await expect(row).toContainText(/Step 1 of 1 · \S/);

  // stop it with its batch: the other tests need the worker's session slots
  await page.evaluate(async () => {
    const list = await fetch('/api/orchestrations').then((r) => r.json()) as { session_id: number; phase: string }[];
    for (const o of list.filter((x) => x.phase !== 'done' && x.phase !== 'stopped')) {
      await fetch(`/api/orchestrations/${o.session_id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stop_children: true }) });
    }
  });
});
