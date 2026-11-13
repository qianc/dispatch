import { expect, test } from '@playwright/test';

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
  await plan.getByRole('link', { name: /\(fake\) ORC work/ }).click();
  await expect(page.getByText(/Part of Move sign-in to the new tokens \(step 1 of 1\)/)).toBeVisible();

  // Activity: the orchestrator's row shows its steps, and the batch says what it is part of
  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByLabel('0 of 1 steps done')).toBeVisible();
  await expect(page.getByText('Move sign-in to the new tokens · step 1 of 1')).toBeVisible();
});
