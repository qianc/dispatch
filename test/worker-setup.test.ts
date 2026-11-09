import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerSetupPrompt, workerSetupSteps, workerSocketUrl } from '../web/src/workerSetup.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => true, useVeryWide: () => true }));

const input = { server: 'https://dispatch.example.com', build: '2026-11-09 12:34', repo: 'https://github.com/acme/dispatch/', name: 'desktop', description: 'Windows desktop in WSL. Has PowerPoint.' };

/** Things that must never be in the prompt: tokens of any kind, passwords, a login. */
const SECRET_LIKE = [
  /\bdsw_[A-Za-z0-9]/, // a worker token
  /\bdsp_[A-Za-z0-9]/, // a personal API token
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/, // GitHub tokens
  /\bgithub_pat_/,
  /\bsk-ant-/, // an Anthropic key
  /password\s*[:=]/i,
  /\bAPP_PASSWORD\b/,
  /Authorization: Bearer (?!\$GITHUB_TOKEN")\S/, // a literal bearer value (the check uses the env variable)
  /@[\w.-]+\.[a-z]{2,}\b/i, // an email address
];

describe('the worker setup prompt (DISP-68)', () => {
  const prompt = workerSetupPrompt(input);

  it('fills in the server, the build, the name and the description', () => {
    expect(prompt).toContain('https://dispatch.example.com');
    expect(prompt).toContain('SERVER_WS_URL=wss://dispatch.example.com/worker');
    expect(prompt).toContain('2026-11-09 12:34 UTC');
    expect(prompt).toContain("--before='2026-11-09 12:34 +0000'");
    expect(prompt).toContain('the worker desktop');
    expect(prompt).toContain('Name: desktop');
    expect(prompt).toContain('Windows desktop in WSL. Has PowerPoint.');
    expect(prompt).toContain('git clone https://github.com/acme/dispatch ~/dispatch');
    expect(prompt).not.toContain('Ask the owner for the address');
  });

  it('holds no token, login or secret, and says where the owner pastes the token', () => {
    for (const re of SECRET_LIKE) expect(prompt, `matches ${re}`).not.toMatch(re);
    // the token's name appears only as the empty line the owner fills in
    expect(prompt).toContain('WORKER_TOKEN=   ← the owner pastes the dsw_ token here');
    expect(prompt).toMatch(/Never ask me to paste a token into this chat, and never print a token/);
  });

  it('tells the LLM to stop and ask before changes beyond the worker\'s own folders', () => {
    expect(prompt).toMatch(/Stop and ask me before any step that changes the machine beyond the worker's own folders/);
    expect(prompt).toContain('anything with sudo');
  });

  it('has every step, in order', () => {
    const titles = workerSetupSteps(input).map((s) => s.title);
    expect(titles).toEqual([
      'Check the machine', 'Get the code', 'Create the worker in Dispatch and get its token', 'Write the worker config',
      'Sign in to Claude on this machine', 'Give the worker GitHub access', 'Start the worker as a service', 'Check it is online',
    ]);
    const at = titles.map((t) => prompt.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // the owner does the browser steps; the LLM never needs their sign-in
    expect(prompt).toContain('Settings → Workers → New worker');
    expect(prompt).toContain('You never need my Dispatch sign-in');
    expect(prompt).toContain('claude setup-token');
    expect(prompt).toContain('systemctl --user enable --now dispatch-worker');
    expect(prompt).toContain('compose.worker.yml');
  });

  it('without a name, repository or build, asks for the name and the address and stays on main', () => {
    const p = workerSetupPrompt({ server: 'http://localhost:3000', build: 'test', repo: '', name: '', description: '' });
    expect(p).toContain('the owner picks the name');
    expect(p).toContain('Ask the owner for the address of the Dispatch repository');
    expect(p).toContain('git clone https://github.com/<you>/dispatch ~/dispatch');
    expect(p).toContain('SERVER_WS_URL=ws://localhost:3000/worker');
    expect(p).not.toContain('git rev-list');
    expect(p).toContain('Stay on `main`');
    for (const re of SECRET_LIKE) expect(p, `matches ${re}`).not.toMatch(re);
  });

  it('turns the web address into the worker socket address', () => {
    expect(workerSocketUrl('https://d.example.com/')).toBe('wss://d.example.com/worker');
    expect(workerSocketUrl('http://localhost:3000')).toBe('ws://localhost:3000/worker');
  });
});

describe('the setup page and its link (DISP-68)', () => {
  beforeEach(stubBrowser);
  afterEach(() => vi.unstubAllGlobals());

  it('Settings → Workers links to the page', async () => {
    const { Settings } = await import('../web/src/pages/Settings.tsx');
    const html = renderPage(createElement(Settings));
    const workers = html.slice(html.indexOf('>Workers<'));
    expect(workers).toContain('href="/settings/worker-setup"');
    expect(textOf(workers)).toContain('Set up a new worker');
  });

  it('shows the prompt with a Copy button and the plain steps, filled from the server', async () => {
    const { WorkerSetup } = await import('../web/src/pages/WorkerSetup.tsx');
    const html = renderPage(createElement(WorkerSetup), { path: '/settings/worker-setup' });
    const text = textOf(html);
    expect(html).toContain('aria-label="Copy the prompt"');
    expect(text).toContain('You are helping me set up a Dispatch worker on this machine');
    expect(text).toContain('http://test'); // location.origin
    expect(text).toContain('SERVER_WS_URL=ws://test/worker');
    expect(html).toContain('placeholder="https://github.com/&lt;you&gt;/dispatch"'); // the repository field, empty on a new device
    expect(text).toContain('The same steps, for a person');
    expect(html).toContain('aria-label="Steps to set up the worker"');
    for (const re of SECRET_LIKE) expect(text, `matches ${re}`).not.toMatch(re);
  });
});
