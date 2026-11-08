import type { Octokit } from '@octokit/rest';
import type { Ctx } from '../src/server/routes/ctx.ts';

/** A stand-in for Octokit: namespaces of methods (`pulls.create`), plus top-level ones (`paginate`). */
export type FakeOcto = Record<string, any>;

/** One call to the fake GitHub: whose token ('shared': the env account's client) and which method. */
export interface GithubCall {
  token: string;
  method: string;
  args: unknown;
}

/**
 * Replaces GitHub for a test server: the shared client (`octo`) and every user's own client
 * (`clientForToken`) answer from `impl`, which the test may change later. Each call is recorded
 * with the token it was made with (DISP-63).
 */
export function fakeGithub(ctx: Pick<Ctx, 'github'>, impl: FakeOcto) {
  const calls: GithubCall[] = [];
  const client = (token: string) => new Proxy({}, {
    get: (_t, ns: string) => {
      const v = impl[ns];
      if (typeof v === 'function') return (...args: unknown[]) => {
        calls.push({ token, method: ns, args: args[1] ?? args[0] });
        return v(...args);
      };
      if (!v || typeof v !== 'object') return v;
      return new Proxy(v, {
        get: (o, name: string) => {
          const fn = o[name];
          if (typeof fn !== 'function') return fn;
          const rec = (args: unknown) => {
            calls.push({ token, method: `${ns}.${name}`, args });
            return fn(args);
          };
          return rec;
        },
      });
    },
  }) as unknown as Octokit;
  Object.defineProperty(ctx.github, 'octo', { value: client('shared'), configurable: true, writable: true });
  ctx.github.clientForToken = (token: string) => client(token);
  return {
    calls,
    /** the calls made with `token` ('shared': the env account) */
    by: (token: string) => calls.filter((c) => c.token === token).map((c) => c.method),
  };
}
