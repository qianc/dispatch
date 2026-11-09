// Set up a new worker (DISP-68): a prompt for an LLM on the new machine, and the same steps in plain
// text. Linked from Settings → Workers. Nothing secret is on this page: the token is pasted on the
// machine, where the steps say.
import { useState } from 'react';
import { Page } from '../components/Layout.tsx';
import { Button, Card, Field, Section, cx, inputCls } from '../components/ui.tsx';
import { REPO_PLACEHOLDER, isCommandLine, workerSetupPrompt, workerSetupSteps, type WorkerSetupInput } from '../workerSetup.ts';

/** The repository address is the same for every worker: kept on this device, like the theme. */
const REPO_KEY = 'dispatch:repo-url';
const savedRepo = () => { try { return localStorage.getItem(REPO_KEY) ?? ''; } catch { return ''; } };
const saveRepo = (url: string) => { try { url.trim() ? localStorage.setItem(REPO_KEY, url.trim()) : localStorage.removeItem(REPO_KEY); } catch { /* memory only */ } };

export function WorkerSetup() {
  const [form, setForm] = useState({ name: '', description: '' });
  const [repo, setRepo] = useState(savedRepo);
  const input: WorkerSetupInput = { server: location.origin, build: __BUILD__, repo, ...form };
  const prompt = workerSetupPrompt(input);
  const steps = workerSetupSteps(input);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const copy = () => {
    const done = navigator.clipboard?.writeText(prompt);
    if (!done) return setCopied('no');
    void done.then(() => setCopied('yes'), () => setCopied('no'));
    setTimeout(() => setCopied(null), 2500);
  };
  return (
    <Page title="Set up a new worker" back="/settings">
      <p className="px-4 pt-4 text-[13px] text-muted">
        A worker runs agent sessions on a machine and connects out to this server. Fill in the worker's name and
        what the machine is for, copy the prompt, and paste it into an LLM (Claude Code, for example) on the new machine:
        it walks you through the steps below. The prompt holds no token or login. The steps say where you paste the token.
      </p>
      <Section title="The worker">
        <div className="mx-3 rounded-xl border border-line bg-panel p-3">
          <Field label="Name" hint="Lowercase letters, digits and dashes.">
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. desktop" autoCapitalize="off" />
          </Field>
          <Field label="Description" hint="What this machine has and when to use it. The planner reads it.">
            <textarea className={cx(inputCls, 'min-h-16')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Windows desktop in WSL. Has PowerPoint. Often asleep." />
          </Field>
          <Field label="Code repository" hint="The public repository the server was built from. Remembered on this device.">
            <input className={inputCls} value={repo} onChange={(e) => { setRepo(e.target.value); saveRepo(e.target.value); }} placeholder={REPO_PLACEHOLDER} autoCapitalize="off" spellCheck={false} />
          </Field>
          <p className="text-[12px] text-faint">Server: {location.origin} · build {__BUILD__} UTC</p>
        </div>
      </Section>
      <Section
        title="Prompt for an LLM on the new machine"
        action={<Button small variant="primary" type="button" onClick={copy} aria-label="Copy the prompt">{copied === 'yes' ? 'Copied' : copied === 'no' ? 'Select and copy' : 'Copy'}</Button>}
      >
        <Card className="p-3">
          <pre className="whitespace-pre-wrap break-words text-[12.5px] leading-snug font-mono select-all" aria-label="The prompt">{prompt}</pre>
        </Card>
      </Section>
      <Section title="The same steps, for a person">
        <Card className="p-3">
          <ol className="list-decimal pl-5 space-y-3 text-[13.5px]" aria-label="Steps to set up the worker">
            {steps.map((s) => (
              <li key={s.title}>
                <div className="font-medium">{s.title}</div>
                <div className="mt-1 space-y-1 text-muted">
                  {s.lines.map((l, i) => (isCommandLine(l)
                    ? <code key={i} className="block break-all rounded bg-bg border border-line px-2 py-1 text-[12px] text-fg select-all">{l.trim()}</code>
                    : <p key={i}>{l}</p>))}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </Section>
    </Page>
  );
}
