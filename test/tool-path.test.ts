import { describe, expect, it } from 'vitest';
import { agentPath, windowsPath, windowsToWsl } from '../src/worker/toolPath.ts';

describe("agents' PATH", () => {
  it('turns Windows folders into WSL folders', () => {
    expect(windowsToWsl('C:\\Program Files\\PowerShell\\7')).toBe('/mnt/c/Program Files/PowerShell/7');
    expect(windowsToWsl('C:\\Windows\\system32\\')).toBe('/mnt/c/Windows/system32');
    expect(windowsToWsl('D:\\')).toBe('/mnt/d');
    expect(windowsToWsl('\\\\server\\share')).toBeNull();
  });

  it("adds Windows' PATH under WSL (existing folders, no duplicates, no unexpanded %VARS%)", () => {
    const exists = (p: string) => !p.includes('Gone');
    const dirs = windowsPath(() => 'C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\PowerShell\\7\;C:\\Gone;%SystemRoot%\\x;C:\\Windows;', exists);
    expect(dirs).toEqual(['/mnt/c/Windows/system32', '/mnt/c/Windows', '/mnt/c/Program Files/PowerShell/7']);
    // interop broken: the folders every Windows has
    expect(windowsPath(() => { throw new Error('no interop'); }, () => true)).toContain('/mnt/c/Windows/System32/WindowsPowerShell/v1.0');
  });

  it('puts extra tools first and Windows last; leaves a PATH alone that has Windows already, or when turned off', () => {
    const env = { HOME: '/home/u', PATH: '/usr/bin:/bin', AGENT_EXTRA_PATH: '~/.local/go/bin' };
    const read = () => 'C:\\Windows\\System32';
    const all = () => true;
    expect(agentPath(env, { wsl: true, readWindowsPath: read, exists: all })).toEqual({
      path: '/home/u/.local/go/bin:/usr/bin:/bin:/mnt/c/Windows/System32',
      added: ['/home/u/.local/go/bin', '/mnt/c/Windows/System32'],
    });
    expect(agentPath(env, { wsl: false, readWindowsPath: read, exists: all }).path).toBe('/home/u/.local/go/bin:/usr/bin:/bin');
    expect(agentPath({ ...env, WINDOWS_PATH: 'off' }, { wsl: true, readWindowsPath: read, exists: all }).path).toBe('/home/u/.local/go/bin:/usr/bin:/bin');
    expect(agentPath({ PATH: '/usr/bin:/mnt/c/WINDOWS' }, { wsl: true, readWindowsPath: read, exists: all })).toEqual({ path: '/usr/bin:/mnt/c/WINDOWS', added: [] });
  });
});
