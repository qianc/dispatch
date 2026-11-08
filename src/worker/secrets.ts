// The secrets this worker knows (DISP-63): its env accounts' tokens, its server tokens, and every
// user's GitHub token a server sent it. Kept in memory for the life of the process, so a token
// never reaches a server in a transcript, a command's output or an error, even after its session.
import { scrub, secretList } from '../shared/scrub.ts';

export class Secrets {
  private values = new Set<string>();
  private list: string[] = [];

  add(v?: string | null) {
    if (!v || this.values.has(v)) return;
    this.values.add(v);
    this.list = secretList(this.values);
  }

  /** `v` with every known secret replaced by [redacted]. */
  scrub<T>(v: T): T {
    return scrub(v, this.list);
  }
}
