import { describe, expect, it } from 'vitest';
import { execForeground, shellInvocation } from './exec.js';

function sh(command: string) {
  return shellInvocation(command, { login: false });
}

describe('execForeground', () => {
  it('returns exit code for a command that finishes on its own', async () => {
    const { cmd, args } = sh('echo hi');
    const out = await execForeground(cmd, args, { idleMs: 300, minRunMs: 100 });
    expect(out.kind).toBe('exited');
    if (out.kind === 'exited') {
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toContain('hi');
    }
  });

  it('hands a long-lived quiet process off to the background', async () => {
    const { cmd, args } = sh('sleep 5');
    const out = await execForeground(cmd, args, { idleMs: 200, minRunMs: 100 });
    expect(out.kind).toBe('running');
    if (out.kind === 'running') {
      expect(out.pid).toBeGreaterThan(0);
      // Don't leak the detached process into the rest of the suite.
      try {
        process.kill(-out.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(out.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  });

  it('detaches immediately when the ready predicate matches', async () => {
    const { cmd, args } = sh('echo "Local: http://localhost:5173"; sleep 5');
    const out = await execForeground(cmd, args, {
      idleMs: 5_000,
      minRunMs: 5_000,
      ready: (o) => o.includes('http://localhost'),
    });
    expect(out.kind).toBe('running');
    if (out.kind === 'running') {
      try {
        process.kill(-out.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(out.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  });
});
