import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { WorkspaceFileError } from './errors.js';

const execFileAsync = promisify(execFile);

export type RevealExecutor = (request: { absolutePath: string; mode: 'file' | 'directory' }) => Promise<void> | void;

export const defaultRevealExecutor: RevealExecutor = async ({ absolutePath, mode }) => {
  const system = platform();
  if (system === 'darwin') {
    const args = mode === 'file' ? ['-R', absolutePath] : [absolutePath];
    await execFileAsync('open', args);
    return;
  }
  if (system === 'win32') {
    // explorer.exe exits with a non-zero code even when it opens the window, so
    // launch failures cannot be distinguished reliably; ignore the exit code.
    const args = mode === 'file' ? [`/select,${absolutePath}`] : [absolutePath];
    try {
      await execFileAsync('explorer', args);
    } catch {
      // ignore
    }
    return;
  }
  throw new WorkspaceFileError('REVEAL_UNAVAILABLE', 'Reveal is only available on macOS and Windows.');
};

export function createDefaultRevealExecutor(): RevealExecutor {
  return defaultRevealExecutor;
}
