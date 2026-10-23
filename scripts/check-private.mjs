#!/usr/bin/env node
// Refuses added lines that carry secrets or private data. Run by the git hooks in .githooks:
//   --staged             the staged changes (pre-commit)
//   --range A..B         the commits in a range (pre-push)
// Patterns: the generic ones below, plus one regex per line from the file in DISPATCH_PRIVATE_PATTERNS
// (default ~/.config/dispatch/private-patterns). Keep personal words (hostnames, project names) in that
// file, not here: this repo is the thing being protected. A line ending in `private-ok` is skipped.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GENERIC = [
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['home folder path', /(?<![\w.])\/(home|Users)\/(?!(?:user|you|runner|node|agent)\/)[a-z][\w.-]{2,}\//],
  ['Windows user path', /[A-Za-z]:\\Users\\(?!user\b|me\b)[\w.-]+/i],
  ['email address', /\b(?!git@)[\w.%+-]+@(?!(?:[\w-]+\.)*(?:example\.(?:com|org|net)|users\.noreply\.github\.com|anthropic\.com)\b)(?![\w.-]*\.(?:example|test|invalid)\b)[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/i],
];

function own() {
  const file = process.env.DISPATCH_PRIVATE_PATTERNS || join(homedir(), '.config/dispatch/private-patterns');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => ['private word', new RegExp(l, 'i')]);
}

const args = process.argv.slice(2);
const diffArgs = args[0] === '--range' ? ['diff', args[1]] : ['diff', '--cached'];
// lock files hold hashes that match anything by chance
const diff = execFileSync('git', [...diffArgs, '--no-color', '-U0', '--', '.', ':!package-lock.json'], { encoding: 'utf8', maxBuffer: 1 << 28 });

const patterns = [...GENERIC, ...own()];
const hits = [];
let file = '';
let line = 0;
for (const l of diff.split('\n')) {
  if (l.startsWith('+++ ')) { file = l.slice(6); continue; }
  const h = /^@@ -\S+ \+(\d+)/.exec(l);
  if (h) { line = Number(h[1]); continue; }
  if (!l.startsWith('+')) continue;
  const text = l.slice(1);
  if (!/private-ok\s*(\*\/|-->)?\s*$/.test(text)) {
    for (const [what, re] of patterns) if (re.test(text)) hits.push(`${file}:${line}  ${what}: ${text.trim().slice(0, 140)}`);
  }
  line++;
}

// commit messages are pushed too
if (args[0] === '--range') {
  const log = execFileSync('git', ['log', '--format=%h %B%x00', args[1]], { encoding: 'utf8', maxBuffer: 1 << 28 });
  for (const msg of log.split('\0')) {
    const [sha] = msg.trim().split(' ', 1);
    for (const l of msg.split('\n')) for (const [what, re] of patterns) if (re.test(l)) hits.push(`commit ${sha} message  ${what}: ${l.trim().slice(0, 140)}`);
  }
}

if (hits.length) {
  console.error(`check-private: ${hits.length} line(s) look private or secret:\n  ${hits.join('\n  ')}`);
  console.error('Use neutral examples (example.com, ACME, /home/user). A false alarm: end the line with a `private-ok` comment.');
  process.exit(1);
}
