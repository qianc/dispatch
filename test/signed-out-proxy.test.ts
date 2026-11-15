// DISP-107: behind a sign-in proxy that answers a signed-out /api request with a redirect to its
// login (Entra, …), the app shows "Signed out" and makes no request the browser blocks, and the
// service worker lets the proxy's return address through to the network.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shellNavigation } from '../web/src/shell.ts';
import { api, ApiError } from '../web/src/api.ts';

const nav = (path: string) => shellNavigation(new URL(path, 'https://dispatch.example.com'));

describe('page loads the service worker answers with the app shell', () => {
  it('covers every route of the app', () => {
    const main = readFileSync(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
    const routes = [...main.matchAll(/\{ path: '([^']+)'/g)].map((m) => m[1].replace(/:\w+/g, 'x1'));
    expect(routes.length).toBeGreaterThan(10);
    for (const r of [...routes, '/pair', '/?next=%2Fauthorize%3Fclient_id%3Da', '/p/DISP?tab=bugs']) expect(nav(r), r).toBe(true);
  });

  it('leaves a sign-in proxy\'s pages to the network', () => {
    for (const p of ['/oauth2/callback?code=1.ASEA&state=x', '/callback?code=1.ASEA&session_state=y&state=x', '/.auth/login/aad/callback', '/oauth2/sign_in', '/signin?to=%2F', '/authorize?client_id=a', '/api/github/oauth/callback?code=c&state=s', '/mcp', '/.well-known/oauth-authorization-server']) {
      expect(nav(p), p).toBe(false);
    }
    // a proxy that returns on an app path
    expect(nav('/?code=1.ASEA&state=x')).toBe(false);
    expect(nav('/settings?error=access_denied&state=x')).toBe(false);
  });
});

describe('an /api request the proxy redirects to its login', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is not followed, and counts as signed out', async () => {
    const events: string[] = [];
    const fetched = vi.fn(async (_url: string, _init: RequestInit) => ({ type: 'opaqueredirect', ok: false, status: 0, statusText: '', headers: new Headers() }));
    vi.stubGlobal('fetch', fetched);
    vi.stubGlobal('window', { dispatchEvent: (e: Event) => events.push(e.type) });
    const err = await api.get('/inbox').catch((e) => e);
    expect(fetched.mock.calls[0][1].redirect).toBe('manual');
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, foreign: true });
    // the app asks /me again
    expect(events).toEqual(['dispatch:unauthorized']);
    // and that answer does not make it ask once more, without end
    expect(await api.get('/me').catch((e) => e)).toMatchObject({ status: 401, foreign: true });
    expect(events).toEqual(['dispatch:unauthorized']);
  });
});
