// Secrets out of what is shown or kept (DISP-63): the worker scrubs every message it sends to a
// server, and the server scrubs again before it saves events.

export const REDACTED = '[redacted]';

/** Shorter values are not secrets (empty, "x", a short name): replacing them would garble text. */
const MIN_SECRET = 8;

/** The secrets worth replacing, longest first: a secret inside a longer one must not leave the longer one's rest. */
export function secretList(secrets: Iterable<string | null | undefined>): string[] {
  return [...new Set([...secrets].filter((s): s is string => !!s && s.length >= MIN_SECRET))].sort((a, b) => b.length - a.length);
}

function replaceAll(text: string, list: string[]) {
  let out = text;
  for (const s of list) if (out.includes(s)) out = out.split(s).join(REDACTED);
  return out;
}

/** `text` with every secret replaced by [redacted]. */
export function scrubText(text: string, secrets: Iterable<string | null | undefined>): string {
  return replaceAll(text, secretList(secrets));
}

function deep(value: unknown, list: string[]): unknown {
  if (typeof value === 'string') return replaceAll(value, list);
  if (Array.isArray(value)) return value.map((v) => deep(v, list));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deep(v, list);
    return out;
  }
  return value;
}

/** A copy of `value` with every secret replaced in every string, however deep in objects and arrays. */
export function scrub<T>(value: T, secrets: Iterable<string | null | undefined>): T {
  const list = secretList(secrets);
  return list.length ? (deep(value, list) as T) : value;
}
