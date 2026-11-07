// Is a Claude account signed in on this worker, and how to sign it in again (DISP-60).
// The check reads the config folder the sessions run with (claudeConfigDir), so the two agree.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { claudeConfigDir, loginCommand, pick, type ClaudeAccount, type ClaudeAccountInfo, type LoginHelp } from '../shared/accounts.ts';

type Env = Record<string, string | undefined>;

const envKey = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** How to fix a token or API key account, which /login does not sign in. */
function tokenFix(a: ClaudeAccount): string {
  // the legacy default account takes them from the plain variables
  const legacy = a.name === 'default';
  return a.kind === 'oauth_token'
    ? `Make a new token with \`claude setup-token\`, put it in ${legacy ? 'CLAUDE_CODE_OAUTH_TOKEN' : `CLAUDE_ACCOUNT_${envKey(a.name)}_OAUTH_TOKEN`} and restart the worker.`
    : `Put a working key in ${legacy ? 'ANTHROPIC_API_KEY' : `CLAUDE_ACCOUNT_${envKey(a.name)}_API_KEY`} and restart the worker.`;
}

export class Logins {
  /** accounts whose login Claude refused: their credentials file (a hash of it) at that moment */
  private failed = new Map<string, string>();

  private accounts: ClaudeAccount[];
  private env: Env;
  private configRoot: string;

  constructor(accounts: ClaudeAccount[], env: Env, configRoot: string) {
    this.accounts = accounts;
    this.env = env;
    this.configRoot = configRoot;
  }

  /** The account a session on `name` runs as (null: the legacy default, with the environment as it is). */
  private resolve(name: string | null) {
    const account = name ? pick(this.accounts, name) : undefined;
    const shown = account ?? this.accounts[0];
    const key = account?.name ?? 'default';
    const tokenKind = shown?.kind === 'oauth_token' || shown?.kind === 'api_key';
    const dir = tokenKind ? null : claudeConfigDir(account, this.env, (n) => join(this.configRoot, n));
    return { account, shown, key, dir, tokenKind };
  }

  private credentials(dir: string): string | null {
    try {
      return readFileSync(join(dir, '.credentials.json'), 'utf8');
    } catch {
      return null;
    }
  }

  private static hash(text: string | null) {
    return text === null ? 'none' : createHash('sha256').update(text).digest('hex');
  }

  /** Whether the account is signed in, and if not, what is still missing. */
  info(name: string | null): ClaudeAccountInfo {
    const { shown, key, dir, tokenKind } = this.resolve(name);
    const base = { name: shown?.name ?? 'default', label: shown?.label ?? 'Claude', kind: shown?.kind ?? 'machine', config_dir: dir };
    const no = (missing: string): ClaudeAccountInfo => ({ ...base, logged_in: false, missing });
    if (tokenKind) {
      if (!this.failed.has(key)) return { ...base, logged_in: true, missing: null };
      return no(`Claude refused the ${shown!.kind === 'oauth_token' ? 'token' : 'API key'}. ${tokenFix(shown!)}`);
    }
    const creds = this.credentials(dir!);
    if (creds === null) return no(`No sign-in found in ${dir}. Run the command (step 2), then /login (step 3).`);
    let oauth: { accessToken?: string; refreshToken?: string; expiresAt?: number } | undefined;
    try {
      oauth = (JSON.parse(creds) as { claudeAiOauth?: typeof oauth }).claudeAiOauth;
    } catch {
      // unreadable: same as no sign-in
    }
    if (!oauth?.accessToken && !oauth?.refreshToken) return no(`The sign-in in ${dir} is not complete. Run /login (step 3) and finish the browser sign-in.`);
    if (!oauth.refreshToken && oauth.expiresAt && oauth.expiresAt < Date.now()) return no(`The sign-in in ${dir} has expired. Run /login (step 3) again.`);
    // /login writes a new credentials file: the same file as when Claude refused it is still the refused login
    if (this.failed.get(key) === Logins.hash(creds)) return no(`The sign-in in ${dir} has not changed since the session stopped. Run /login (step 3) and finish the browser sign-in.`);
    return { ...base, logged_in: true, missing: null };
  }

  /** Claude refused the account's login: note it (for the check), and say how to sign in again. */
  failedNow(name: string | null, error: string, detail: string): LoginHelp {
    const { shown, key, dir, tokenKind } = this.resolve(name);
    this.failed.set(key, tokenKind ? 'token' : Logins.hash(this.credentials(dir!)));
    const fix = tokenKind ? tokenFix(shown!) : null;
    return {
      account: name,
      label: shown?.label ?? 'Claude',
      kind: shown?.kind ?? 'machine',
      config_dir: dir,
      command: dir ? loginCommand(dir) : null,
      fix,
      error,
      detail,
      host: hostname(),
    };
  }
}

/** The notice for a session whose account Claude refused (DISP-60): the text for old apps and the push, and the steps. */
export function loginNotice(help: LoginHelp): { title: string; body: string; login: LoginHelp } {
  const body = help.command
    ? `On ${help.host} run \`${help.command}\`, then /login and finish the browser sign-in. Then press Retry in the session.`
    : `${help.fix ?? 'Log in again on the worker machine.'} Then press Retry in the session.`;
  return { title: `${help.label} account needs attention (${help.error.replace(/_/g, ' ')})`, body, login: help };
}
