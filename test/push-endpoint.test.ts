import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPublicAddress, pushEndpointProblem } from '../src/server/pushEndpoint.ts';
import { OWNER, startServer } from './helpers.ts';

const keys = { p256dh: 'p', auth: 'a' };

describe('push endpoints are public https addresses only (DISP-225)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    s = await startServer();
  });
  afterEach(() => s.app.close());

  it('refuses http and private, loopback and link-local endpoints, and stores none of them', async () => {
    for (const endpoint of [
      'http://push.example/x',
      'http://192.168.10.1/x',
      'https://192.168.10.1/x',
      'https://10.0.0.5/x',
      'https://172.16.3.4/x',
      'https://127.0.0.1:8080/x',
      'https://0x7f.1/x',
      'https://169.254.169.254/latest',
      'https://[::1]/x',
      'https://[fe80::1]/x',
      'https://[fd00::1]/x',
      'https://[::ffff:192.168.10.1]/x',
      'https://localhost/x',
      'https://app.localhost/x',
      'https://nas/x',
      'https://nas.home.arpa/x',
      'https://user:pw@push.example/x',
    ]) {
      const r = await s.call('POST', '/push/subscribe', { endpoint, keys });
      expect(r.status, endpoint).toBe(400);
    }
    expect(s.ctx.store.pushSubscriptions(OWNER)).toHaveLength(0);
  });

  it('accepts a public https endpoint', async () => {
    expect((await s.call('POST', '/push/subscribe', { endpoint: 'https://push.example/dev', keys })).status).toBe(200);
  });

  it('a name that resolves to a private address is refused', async () => {
    expect(await pushEndpointProblem('https://localhost./x')).toMatch(/public/);
  });

  it('knows public from non-public addresses', () => {
    expect(isPublicAddress('17.188.143.173')).toBe(true);
    expect(isPublicAddress('2620:149:f9:1023::d')).toBe(true);
    for (const ip of ['192.168.10.3', '100.64.1.1', '0.0.0.0', '::', '224.0.0.1']) expect(isPublicAddress(ip), ip).toBe(false);
  });
});
