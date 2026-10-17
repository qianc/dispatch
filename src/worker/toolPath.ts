// The PATH agents get. Extra tool folders (AGENT_EXTRA_PATH, e.g. a Go install) go first. Under WSL,
// Windows' own PATH is added at the end, as a Windows terminal does: a worker started by systemd
// (not from a Windows terminal) otherwise cannot find powershell.exe, so PowerPoint and other
// Windows tools are out of reach. WINDOWS_PATH=off turns that part off.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** "C:\\Program Files\\Go\\bin" → "/mnt/c/Program Files/Go/bin"; null for paths that are not on a drive. */
export function windowsToWsl(p: string): string | null {
  const m = p.trim().replace(/[\\/]+$/, '').match(/^([A-Za-z]):[\\/]?(.*)$/);
  if (!m) return null;
  const rest = m[2].replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** Windows' PATH, as WSL folders that exist. */
export function windowsPath(readWindowsPath: () => string, exists: (p: string) => boolean = existsSync): string[] {
  let raw = '';
  try {
    raw = readWindowsPath();
  } catch {
    // interop off or broken: fall back to the folders every Windows has
  }
  const dirs = raw
    ? raw.split(';').map((d) => d.trim()).filter((d) => d && !d.includes('%')).map(windowsToWsl).filter((d): d is string => !!d)
    : ['/mnt/c/Windows/System32', '/mnt/c/Windows', '/mnt/c/Windows/System32/Wbem', '/mnt/c/Windows/System32/WindowsPowerShell/v1.0', '/mnt/c/Program Files/PowerShell/7'];
  return [...new Set(dirs)].filter((d) => exists(d));
}

export function agentPath(env: Record<string, string | undefined>, opts: { wsl: boolean; readWindowsPath: () => string; exists?: (p: string) => boolean }): { path: string; added: string[] } {
  const home = env.HOME ?? '';
  const current = (env.PATH ?? '').split(':').filter(Boolean);
  const extra = (env.AGENT_EXTRA_PATH ?? '').split(':').map((d) => d.trim().replace(/^~(?=$|\/)/, home)).filter(Boolean);
  const windows = opts.wsl && env.WINDOWS_PATH !== 'off' && !current.some((d) => d.startsWith('/mnt/'))
    ? windowsPath(opts.readWindowsPath, opts.exists)
    : [];
  const added = [...extra, ...windows].filter((d) => !current.includes(d));
  const path = [...extra.filter((d) => !current.includes(d)), ...current, ...windows.filter((d) => !current.includes(d))].join(':');
  return { path, added };
}

/** Set this process's PATH (agents and git inherit it). Returns what was added, for the log. */
export function setAgentPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const wsl = existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
  const { path, added } = agentPath(env, {
    wsl,
    // run from a Windows folder: cmd.exe complains about the WSL (UNC) current directory otherwise
    readWindowsPath: () => execFileSync('/mnt/c/Windows/System32/cmd.exe', ['/d', '/c', 'echo %PATH%'], { cwd: '/mnt/c', timeout: 10_000, encoding: 'utf8' }).trim(),
  });
  env.PATH = path;
  return added;
}
