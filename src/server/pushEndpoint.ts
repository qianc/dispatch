// Push endpoints are URLs a person gives the server, which then POSTs to them (DISP-225): only
// public https addresses, never the server's own machine or its LAN.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  // IPv4-mapped addresses (::ffff:a.b.c.d) are checked against the IPv4 rules by BlockList itself
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, bits, 'ipv6');

/** Names that only mean something on this machine or its LAN. */
const LOCAL_NAME = /(^|\.)(localhost|local|lan|home|internal|intranet|home\.arpa|localdomain)$/i;

/** False for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPublicAddress(ip: string) {
  const family = isIP(ip);
  if (!family) return false;
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** How long a name lookup may take; a name that does not resolve cannot be reached either. */
const LOOKUP_MS = 3000;

/**
 * Why `endpoint` is refused as a push endpoint, or null when it is fine: https only, no credentials,
 * and a host that is (and resolves to) public addresses only.
 */
export async function pushEndpointProblem(endpoint: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'https:') return 'push endpoints must use https';
  if (u.username || u.password) return 'push endpoints cannot carry credentials';
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host)) return isPublicAddress(host) ? null : 'push endpoints must be on a public address';
  if (!host.includes('.') || LOCAL_NAME.test(host)) return 'push endpoints must be on a public address';
  const addrs = await Promise.race([
    lookup(host, { all: true }).catch(() => []),
    new Promise<{ address: string }[]>((r) => setTimeout(() => r([]), LOOKUP_MS).unref()),
  ]);
  if (addrs.some((a) => !isPublicAddress(a.address))) return 'push endpoints must be on a public address';
  return null;
}
