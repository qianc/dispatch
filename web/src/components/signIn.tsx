// Signing a worker's Claude account in again, step by step, then Retry (DISP-60).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ClaudeAccountInfo, LoginHelp } from '../../../src/shared/accounts.ts';
import type { Session } from '../../../src/shared/types.ts';
import { api } from '../api.ts';
import { Button, ErrorText, cx } from './ui.tsx';

/** A command to run, with a Copy button. */
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1 flex items-center gap-2 rounded-lg bg-bg border border-line px-2 py-1.5">
      <code className="flex-1 min-w-0 break-all text-[12.5px] select-all">{command}</code>
      <Button
        small type="button" variant="ghost" aria-label="Copy the command"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => setCopied(false));
          setTimeout(() => setCopied(false), 2000);
        }}
      >{copied ? 'Copied' : 'Copy'}</Button>
    </div>
  );
}

/**
 * The numbered steps: which machine, the exact command for the account's config folder, /login,
 * then the button that checks it (`last`). Token and API key accounts get their fix instead.
 */
export function SignInSteps({ worker, host, command, fix, last }: { worker: string; host?: string | null; command: string | null; fix: string | null; last: string }) {
  const machine = host && host !== worker ? `${worker} (host ${host})` : worker;
  return (
    <ol className="list-decimal pl-5 space-y-1.5 text-[13px]" aria-label="Steps to sign in">
      <li>Open a terminal on the worker machine <strong>{machine}</strong>.</li>
      {command ? (
        <>
          <li>Run this command. It opens Claude with the account's own config folder:<CopyCommand command={command} /></li>
          <li>In Claude, type <code>/login</code> and finish the sign-in in the browser.</li>
        </>
      ) : (
        <li>{fix ?? 'Fix the account on the worker machine.'}</li>
      )}
      <li>{last}</li>
    </ol>
  );
}

/**
 * A session stopped on a signed-out account: the steps, Retry (checks the account on the worker,
 * then resumes the session), and Mark as complete after it, for when the work is done anyway.
 */
export function SignInPanel({ sessionId, help, onComplete, busy }: { sessionId: number; help: LoginHelp; onComplete: () => void; busy: boolean }) {
  const qc = useQueryClient();
  const [missing, setMissing] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: () => api.post<{ resumed: boolean; account: ClaudeAccountInfo; session: Session }>(`/sessions/${sessionId}/retry-login`, {}),
    onSuccess: (r) => {
      setMissing(r.resumed ? null : r.account.missing ?? 'The account is still not signed in.');
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ['workers'] });
    },
  });
  return (
    <section className="w-full rounded-xl border border-wait/40 bg-wait/5 px-3 py-2.5" aria-label="Sign in to continue">
      <h3 className="text-[14px] font-semibold mb-1.5">Sign in the {help.label} account to continue</h3>
      <SignInSteps worker={help.worker ?? help.host} host={help.host} command={help.command} fix={help.fix} last="Press Retry. Dispatch checks the sign-in and resumes the session where it stopped." />
      {missing && <p role="status" className="mt-2 text-[13px] text-bad">Not signed in yet: {missing}</p>}
      <div className="flex flex-wrap gap-2 mt-2.5">
        <Button small variant="primary" disabled={retry.isPending || busy} onClick={() => retry.mutate()}>{retry.isPending ? 'Checking…' : 'Retry'}</Button>
        <Button small disabled={retry.isPending || busy} onClick={onComplete}>Mark as complete</Button>
      </div>
      <ErrorText error={retry.error} />
      <details className="mt-2 text-[12px] text-muted">
        <summary className="cursor-pointer select-none">Error details</summary>
        <p className={cx('mt-1 whitespace-pre-wrap break-words font-mono')}>{[help.error, help.detail].filter(Boolean).join('\n')}</p>
      </details>
    </section>
  );
}
