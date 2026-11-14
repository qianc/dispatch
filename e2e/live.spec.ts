import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures.ts';
import { E2E_REPOS } from './setup.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Password').fill('e2e-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
}

test('a pasted image goes with the message, Claude sees it and can attach it to an item (DISP-34)', async ({ page }) => {
  await signIn(page);
  const api = (path: string, data: unknown) => page.request.post(`/api${path}`, { data });
  await api('/projects', { key: 'PST', name: 'Paste' });
  await api('/projects/PST/repos', { github_owner: 'me', github_name: 'pst' });
  const item = await (await api('/projects/PST/items', { title: 'Login breaks' })).json();
  const s = await (await api('/projects/PST/batches', { prompt: 'go' })).json();
  await page.goto(`/s/${s.id}`);
  await page.getByRole('button', { name: /Small fix/ }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByText('Your turn')).toBeVisible();

  // paste a screenshot into the message box
  const box = page.getByLabel('Message');
  await box.fill('attach it to PST-1');
  await box.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG);
  await expect(page.getByRole('img', { name: 'Pasted image' })).toBeVisible();
  await expect(page.getByLabel('Message')).toHaveValue('attach it to PST-1'); // the image is not pasted as text
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/\(fake\) I see 1 pasted image\(s\): image\/png 70 bytes\. Attached the first to PST-1\./)).toBeVisible();
  await expect(page.getByRole('img', { name: 'Pasted image' })).toHaveCount(0); // sent: the box is empty again
  // the message shows the image, which opens full size
  const thumb = page.getByRole('button', { name: 'Show image' });
  await expect(thumb.locator('img')).toHaveJSProperty('naturalWidth', 1);
  // and the item has it
  const it = await (await page.request.get(`/api/items/${item.id}`)).json();
  expect(it.images).toEqual([expect.objectContaining({ name: 'screenshot.png', author: 'claude' })]);

  // an image alone can be sent, picked with the button
  await page.locator('input[type=file]').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
  await expect(page.getByRole('img', { name: 'Pasted image' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('(fake) I see 1 pasted image(s): image/png 70 bytes.', { exact: true })).toBeVisible();
  await api(`/sessions/${s.id}/finish`, { status: 'completed', cleanup: false });
});

test('while the check runs before a merge, the session shows its progress, then it goes away (DISP-5)', async ({ page }) => {
  await signIn(page);
  const api = (path: string, data: unknown) => page.request.post(`/api${path}`, { data });
  const dir = `${E2E_REPOS}/chk`;
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet', '-b', 'main');
  git(dir, 'config', 'receive.denyCurrentBranch', 'updateInstead'); // merges update the checked-out main
  writeFileSync(`${dir}/a.txt`, 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'one');
  await api('/projects', { key: 'CHK', name: 'Check' });
  const check = "printf ' ✓ test/a.test.ts (3 tests) 1ms\\n'; sleep 3; printf ' ❯ test/b.test.ts (2 tests | 1 failed) 1ms\\n'; sleep 3";
  expect((await api('/projects/CHK/repos', { local_path: dir, check_command: check })).ok()).toBe(true);
  const s = await (await api('/projects/CHK/batches', { prompt: 'go' })).json();
  // it only needs the branch: finish it, so it does not hold a worker slot other tests wait for
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${s.id}`)).json()).session.status).toBe('waiting_input');
  await api(`/sessions/${s.id}/finish`, { status: 'completed', cleanup: false });
  // the work the session did, on its branch
  git(dir, 'checkout', '--quiet', '-b', s.branch);
  writeFileSync(`${dir}/b.txt`, 'two\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'two');
  git(dir, 'checkout', '--quiet', 'main');
  const [pr] = await (await api(`/sessions/${s.id}/sync-prs`, {})).json();
  await page.goto(`/s/${s.id}`);
  const merging = api(`/prs/${pr.id}/merge`, { how: 'local', method: 'merge' });
  const card = page.getByRole('status', { name: 'Tests running in chk' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('3 passed');
  await expect(card).toContainText('no earlier run to estimate from');
  await expect(card).toContainText('test/a.test.ts');
  await expect(card).toContainText('1 failed');
  await page.screenshot({ path: 'test-results/check-progress.png' });
  expect(await (await merging).json()).toMatchObject({ ok: true });
  await expect(card).toHaveCount(0);
});
