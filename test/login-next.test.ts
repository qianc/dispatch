// DISP-137: ?next= after a password login stays on Dispatch's own origin, by the server's safePath rule
import { describe, expect, it } from 'vitest';
import { nextPath } from '../web/src/pages/Login.tsx';

const ORIGIN = 'https://dispatch.example.com';
const next = (to: string) => nextPath(`?next=${encodeURIComponent(to)}`, ORIGIN);

describe('nextPath', () => {
  it('refuses paths a browser reads as another site', () => {
    for (const to of ['/\\evil.example', '/\t/evil.example', '//evil.example', '/\n/evil.example', ' /x', 'https://evil.example/', 'evil.example']) {
      expect(next(to), JSON.stringify(to)).toBeNull();
    }
    expect(nextPath('?next=/%5Cevil.example', ORIGIN)).toBeNull();
    expect(nextPath('?next=/%09/evil.example', ORIGIN)).toBeNull();
    expect(nextPath('', ORIGIN)).toBeNull();
  });

  it('keeps normal paths', () => {
    expect(next('/authorize?request=abc&x=1')).toBe('/authorize?request=abc&x=1');
    expect(next('/p/DISP/items/132#top')).toBe('/p/DISP/items/132#top');
    expect(next('/')).toBe('/');
  });
});
