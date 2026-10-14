// RUNNER=fake: a scripted stand-in for Claude, for UI work and e2e tests without using the subscription.
import { randomUUID } from 'node:crypto';
import type { StartSpec } from '../shared/protocol.ts';
import type { InputAnswer, PendingInputPayload } from '../shared/types.ts';
import type { AgentRunner, RunnerDeps } from './runner.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeRunner implements AgentRunner {
  readonly sessionId: number;
  private spec: StartSpec;
  private deps: RunnerDeps;
  private waiting = new Map<string, (a: InputAnswer | null) => void>();
  private closed = false;
  private turn = 0;
  private delay: number;

  constructor(spec: StartSpec, deps: RunnerDeps, delayMs = Number(process.env.FAKE_DELAY_MS ?? 300)) {
    this.sessionId = spec.session_id;
    this.spec = spec;
    this.deps = deps;
    this.delay = delayMs;
  }

  start(text: string) {
    this.deps.emit({ t: 'status', session_id: this.sessionId, status: 'running', sdk_session_id: this.spec.resume ?? `fake-${randomUUID()}` });
    void this.run(text);
  }

  push(text: string) {
    void this.run(text);
  }

  answer(localId: string, answer: InputAnswer) {
    this.waiting.get(localId)?.(answer);
    this.waiting.delete(localId);
  }

  async interrupt() {
    for (const r of this.waiting.values()) r(null);
    this.waiting.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    void this.interrupt();
    this.deps.onClosed();
  }

  private say(text: string) {
    this.deps.emit({ t: 'event', session_id: this.sessionId, body: { kind: 'assistant', text } });
  }

  private ask(payload: PendingInputPayload) {
    const local_id = randomUUID();
    return new Promise<InputAnswer | null>((resolve) => {
      this.waiting.set(local_id, resolve);
      this.deps.emit({ t: 'input_request', session_id: this.sessionId, local_id, payload });
    });
  }

  private finishTurn() {
    this.deps.emit({ t: 'event', session_id: this.sessionId, body: { kind: 'result', subtype: 'success', cost_usd: 0, turns: 1, duration_ms: this.delay } });
    this.deps.emit({ t: 'status', session_id: this.sessionId, status: 'idle' });
  }

  private async run(text: string) {
    this.turn++;
    await sleep(this.delay);
    if (this.closed) return;
    if (this.spec.kind === 'planner') return this.plannerTurn();
    if (this.spec.kind === 'assistant') return this.assistantTurn(text);
    if (this.spec.kind === 'discuss') {
      this.say(`(fake) About ${this.spec.items[0]?.key}: ${this.spec.items[0]?.title}. You asked: ${text}`);
      return this.finishTurn();
    }
    if (this.turn > 1) {
      this.say(`(fake) You said: ${text}`);
      return this.finishTurn();
    }
    this.say(`(fake) Starting on ${this.spec.items.map((i) => i.key).join(', ') || 'the prompt'} in branch \`${this.spec.branch}\`.`);
    if (this.spec.force_plan) {
      const a = await this.ask({ kind: 'plan_approval', plan: '## Plan\n\n1. Read the code\n2. Make the change\n3. Open a PR' });
      if (!a || (a.kind === 'plan_approval' && !a.approve)) {
        this.say('(fake) Plan not approved. Tell me what to change.');
        return this.finishTurn();
      }
    }
    const a = await this.ask({
      kind: 'question',
      questions: [{
        question: 'Which approach should I take?', header: 'Approach', multiSelect: false,
        options: [{ label: 'Small fix', description: 'Change only what is needed' }, { label: 'Refactor', description: 'Clean up the module too' }],
      }],
    });
    if (!a) return this.finishTurn();
    const choice = a.kind === 'question' ? Object.values(a.answers)[0] : 'n/a';
    this.deps.emit({ t: 'event', session_id: this.sessionId, body: { kind: 'tool_use', tool_use_id: 't1', name: 'Bash', summary: 'npm test', input: { command: 'npm test' } } });
    await sleep(this.delay);
    this.deps.emit({ t: 'event', session_id: this.sessionId, body: { kind: 'tool_result', tool_use_id: 't1', is_error: false, text: 'All tests passed' } });
    this.say(`(fake) Done with "${choice}". In a real session I would now push and open a PR.`);
    this.finishTurn();
  }

  /** "create project <Name> <owner/repo>" creates it; anything else lists projects. */
  private async assistantTurn(text: string) {
    const m = text.match(/create project (\S+)(?: (\S+\/\S+))?/i);
    if (m) {
      const r = (await this.deps.rpc('create_project', { name: m[1], repos: m[2] ? [m[2]] : [] })) as { key: string; link: string };
      this.say(`(fake) Created [${r.key}](${r.link}).`);
    } else {
      const list = (await this.deps.rpc('list_projects', {})) as { key: string }[];
      this.say(`(fake) You have ${list.length} project(s): ${list.map((p) => p.key).join(', ') || 'none'}.`);
    }
    this.finishTurn();
  }

  private async plannerTurn() {
    const items = (await this.deps.rpc('list_items', {})) as { id: number; key: string; title: string }[];
    if (this.spec.source) {
      await this.deps.rpc('propose', {
        type: 'items', source_id: this.spec.source.id,
        items: [
          { type: 'bug', title: `(fake) Bug from ${this.spec.source.title}`, body_md: 'Found in the retro.', importance: 3, effort: 1 },
          { type: 'backlog', title: '(fake) Follow-up improvement', body_md: '', importance: 2, effort: 2 },
        ],
      });
      this.say('(fake) I split the source into 2 items. Check the card.');
    } else {
      await this.deps.rpc('propose', {
        type: 'batch', title: '(fake) Next batch', item_ids: items.slice(0, 2).map((i) => i.id), new_items: [],
        prompt: 'Keep the change small.', force_plan: false,
      });
      this.say(`(fake) I suggest ${items.slice(0, 2).map((i) => i.key).join(' + ') || 'nothing yet'}.`);
    }
    this.finishTurn();
  }
}
