// Each person's own GitHub connection (DISP-63): through the GitHub OAuth App ("Connect with
// GitHub") or a pasted personal access token. The token is sealed (secretBox.ts), bound to its
// user, and leaves the server only for that user's own sessions; answers carry login, name and
// email, never the token.
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { now } from './db.ts';
import { HttpError } from './routes/ctx.ts';
import type { SecretBox } from './secretBox.ts';

export type IdentityKind = 'oauth' | 'pat';

/** Who a token belongs to, as GitHub says. */
export interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  /** primary verified email, when the token may see it */
  email: string | null;
  /** classic tokens: the X-OAuth-Scopes header; fine-grained tokens have none (null) */
  scopes: string | null;
}

/** A connection as Settings shows it (no token). */
export interface IdentityInfo {
  kind: IdentityKind;
  github_id: number;
  login: string;
  git_name: string;
  git_email: string;
  scopes: string | null;
  created_at: string;
  verified_at: string | null;
  last_error: string | null;
}

/** What a session needs to act on GitHub as its user. */
export interface GithubCredential {
  login: string;
  token: string;
  git_name: string;
  git_email: string;
}

export const KEY_CHANGED = 'Dispatch cannot read this token any more (its key changed). Connect again.';
const UA = { 'user-agent': 'dispatch', accept: 'application/vnd.github+json' };
const aad = (user: string) => `github:${user}`;

export class Identities {
  private db: Db;
  private box: SecretBox;
  private cfg: Pick<Config, 'githubApiUrl' | 'githubGitBase' | 'githubOAuth'>;

  constructor(db: Db, box: SecretBox, cfg: Pick<Config, 'githubApiUrl' | 'githubGitBase' | 'githubOAuth'>) {
    this.db = db;
    this.box = box;
    this.cfg = cfg;
  }

  /** GitHub's web address (sign-in pages): GITHUB_GIT_BASE when it is a web address, else github.com. */
  get webBase(): string {
    return /^https?:\/\//.test(this.cfg.githubGitBase) ? this.cfg.githubGitBase : 'https://github.com';
  }

  /** Who the token belongs to (a seam: tests replace it). */
  async profile(token: string): Promise<GithubProfile> {
    const headers = { ...UA, authorization: `Bearer ${token}` };
    let res: Response;
    try {
      res = await fetch(`${this.cfg.githubApiUrl}/user`, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new HttpError(502, `Cannot reach GitHub: ${(e as Error).message}`);
    }
    if (res.status === 401) throw new HttpError(400, 'GitHub did not accept this token.');
    if (!res.ok) throw new HttpError(502, `GitHub answered ${res.status} when asked who this token is.`);
    const u = (await res.json()) as { id: number; login: string; name: string | null };
    let email: string | null = null;
    try {
      const r = await fetch(`${this.cfg.githubApiUrl}/user/emails`, { headers, signal: AbortSignal.timeout(15_000) });
      if (r.ok) email = ((await r.json()) as { email: string; primary: boolean; verified: boolean }[]).find((e) => e.primary && e.verified)?.email ?? null;
    } catch {
      // best effort: the noreply address works too
    }
    return { id: u.id, login: u.login, name: u.name || null, email, scopes: res.headers.get('x-oauth-scopes') };
  }

  /** The OAuth App's code → an access token (a seam: tests replace it). */
  async exchange(code: string): Promise<string> {
    const app = this.cfg.githubOAuth;
    if (!app) throw new Error('GitHub sign-in is not set up.');
    const res = await fetch(`${this.webBase}/login/oauth/access_token`, {
      method: 'POST',
      headers: { ...UA, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
    if (!res.ok || !data.access_token) throw new Error(`GitHub refused the sign-in: ${data.error_description ?? data.error ?? res.status}`);
    return data.access_token;
  }

  /** Ends the OAuth App's grant for this token on GitHub (a seam: tests replace it). */
  async revoke(token: string): Promise<void> {
    const app = this.cfg.githubOAuth;
    if (!app) return;
    await fetch(`${this.cfg.githubApiUrl}/applications/${app.clientId}/grant`, {
      method: 'DELETE',
      headers: { ...UA, authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(15_000),
    });
  }

  /** Checks the token with GitHub and keeps it (sealed) as `user`'s connection, replacing any other. */
  async connect(user: string, token: string, kind: IdentityKind): Promise<IdentityInfo> {
    let p: GithubProfile;
    try {
      p = await this.profile(token);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
    if (p.scopes !== null) {
      const scopes = p.scopes.split(',').map((s) => s.trim());
      if (!scopes.includes('repo')) {
        throw new HttpError(400, `This token cannot push: it lacks the "repo" scope (it has: ${scopes.filter(Boolean).join(', ') || 'none'}). Make a token with "repo", or a fine-grained token with access to your repositories.`);
      }
    }
    const email = p.email ?? `${p.id}+${p.login}@users.noreply.github.com`;
    this.db.run(
      `INSERT INTO github_identities (user, kind, github_id, login, git_name, git_email, token_enc, scopes, verified_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(user) DO UPDATE SET kind = excluded.kind, github_id = excluded.github_id, login = excluded.login,
         git_name = excluded.git_name, git_email = excluded.git_email, token_enc = excluded.token_enc, scopes = excluded.scopes,
         created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), verified_at = excluded.verified_at, last_error = NULL`,
      user, kind, p.id, p.login, p.name ?? p.login, email, this.box.seal(token, aad(user)), p.scopes, now(),
    );
    return this.info(user)!;
  }

  /** The token, or null when this key cannot read it (sealed with another key). */
  private open(user: string, sealed: string): string | null {
    try {
      return this.box.open(sealed, aad(user));
    } catch {
      return null;
    }
  }

  /**
   * Why the connection cannot be used, or null. A token this key cannot read is told at read time,
   * never written down: with the right key back, it works again. GitHub turning it away is kept.
   */
  private errorOf(r: { user: string; token_enc: string; last_error: string | null }): string | null {
    if (this.open(r.user, r.token_enc) === null) return KEY_CHANGED;
    // an older Dispatch wrote "key changed" down; the token reads now
    return r.last_error === KEY_CHANGED ? null : r.last_error;
  }

  /** The user's credential; `{error}` when it cannot be used (connect again); null: not connected. */
  get(user: string): GithubCredential | { error: string } | null {
    const r = this.db.get<{ user: string; login: string; git_name: string; git_email: string; token_enc: string; last_error: string | null }>(
      'SELECT user, login, git_name, git_email, token_enc, last_error FROM github_identities WHERE user = ?', user,
    );
    if (!r) return null;
    const error = this.errorOf(r);
    if (error) return { error };
    return { login: r.login, token: this.open(user, r.token_enc)!, git_name: r.git_name, git_email: r.git_email };
  }

  /** The connection without its token, or null. */
  info(user: string): IdentityInfo | null {
    const r = this.db.get<IdentityInfo & { user: string; token_enc: string }>(
      'SELECT user, token_enc, kind, github_id, login, git_name, git_email, scopes, created_at, verified_at, last_error FROM github_identities WHERE user = ?', user,
    );
    if (!r) return null;
    const { user: _u, token_enc: _t, ...info } = r;
    return { ...info, last_error: this.errorOf(r) };
  }

  /** Users whose connection works (as far as Dispatch knows). */
  listConnected(): { user: string; login: string }[] {
    return this.db.all<{ user: string; login: string; token_enc: string; last_error: string | null }>('SELECT user, login, token_enc, last_error FROM github_identities ORDER BY user')
      .filter((r) => !this.errorOf(r))
      .map(({ user, login }) => ({ user, login }));
  }

  /** Forgets the connection; an OAuth one is also ended on GitHub (best effort). */
  async disconnect(user: string) {
    const r = this.db.get<{ kind: IdentityKind }>('SELECT kind FROM github_identities WHERE user = ?', user);
    if (!r) return;
    const cred = this.get(user);
    this.db.run('DELETE FROM github_identities WHERE user = ?', user);
    if (r.kind === 'oauth' && cred && 'token' in cred) {
      await this.revoke(cred.token).catch((e) => console.warn(`could not end ${user}'s GitHub grant:`, (e as Error).message));
    }
  }

  /** GitHub turned the token away: the user must connect again. */
  markRejected(user: string, message: string) {
    this.db.run('UPDATE github_identities SET last_error = ? WHERE user = ?', message, user);
  }
}
