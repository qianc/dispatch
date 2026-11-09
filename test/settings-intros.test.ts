import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => true, useVeryWide: () => true }));

let Settings: typeof import('../web/src/pages/Settings.tsx').Settings;
beforeEach(async () => {
  stubBrowser();
  ({ Settings } = await import('../web/src/pages/Settings.tsx'));
});
afterEach(() => vi.unstubAllGlobals());

describe('Settings explains Tokens, Connected apps and Paired devices (DISP-67)', () => {
  /** The section's text from its heading to the next heading. */
  const section = (text: string, title: string) => {
    const start = text.indexOf(title);
    expect(start, `a ${title} heading`).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start + title.length);
    const next = rest.search(/Tokens|Connected apps|Paired devices|Status/);
    return rest.slice(0, next < 0 ? undefined : next);
  };

  it('shows an intro line under each of the three headings, before its list', () => {
    const text = textOf(renderPage(createElement(Settings)));

    const tokens = section(text, 'Tokens');
    expect(tokens).toMatch(/^\s*Personal keys for your own scripts and skills, such as a command-line tool that calls Dispatch\. You make one here, copy it once, and it is not shown again\. Revoke it to stop every script that uses it\. Each token has the actions it may take and an optional expiry\./);
    expect(tokens).toContain('No tokens. Scripts and skills need one to reach Dispatch.'); // the empty state stays

    const apps = section(text, 'Connected apps');
    expect(apps).toMatch(/^\s*Apps that sign in to Dispatch as you through a connector, such as Claude's connector for \/mcp\. Nothing to copy: you approve the app once, from the app\. Disconnect to end its access\. It stops until you connect it again\./);
    expect(apps).toContain('Add Dispatch as a connector in Claude');

    const devices = section(text, 'Paired devices');
    expect(devices).toMatch(/^\s*Phones and home-screen apps you have signed in on with a code shown on the device\. Each pairing lasts 90 days, then it must be paired again\. Unpair to end the device's access at once\./);
  });
});
