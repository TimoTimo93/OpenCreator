import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const rootDir = resolve(desktopDir, '../..');
const isWin = process.platform === 'win32';
const pnpmCmd = isWin ? 'pnpm.cmd' : 'pnpm';
const openCreatorHome = process.env.OPENCREATOR_HOME || resolve(rootDir, '.opencreator');
process.env.OPENCREATOR_HOME = openCreatorHome;
process.env.OPENCREATOR_LANG = process.env.OPENCREATOR_LANG || 'vi-VN';
if (!process.env.OPENCREATOR_NODE_BIN && existsSync('C:\\Program Files\\nodejs\\node.exe')) {
  process.env.OPENCREATOR_NODE_BIN = 'C:\\Program Files\\nodejs\\node.exe';
}
let webProcess;

try {
  await run(pnpmCmd, ['--filter', '@opencreator/daemon', 'build'], rootDir);
  await run(pnpmCmd, ['--filter', '@opencreator/desktop', 'build'], rootDir);
  await run(pnpmCmd, ['--filter', '@opencreator/web', 'build'], rootDir);
  if (process.env.OPENCREATOR_DESKTOP_DEV_SERVER === '1') {
    if (!(await isPortOpen(19861))) {
      webProcess = spawn(pnpmCmd, ['--filter', '@opencreator/web', 'dev'], {
        cwd: rootDir,
        env: {
          ...process.env,
          OPENCREATOR_HOME: openCreatorHome,
          OPENCREATOR_LANG: process.env.OPENCREATOR_LANG,
          OPENCREATOR_DESKTOP_DEV: '1'
        },
        stdio: 'inherit',
        shell: isWin
      });
      await waitForPort(19861, 30_000);
    }
  }
  const code = await run(electron, ['.'], desktopDir, {
    ...process.env,
    OPENCREATOR_HOME: openCreatorHome,
    OPENCREATOR_LANG: process.env.OPENCREATOR_LANG,
    OPENCREATOR_DESKTOP_DEV: '1'
  });
  process.exitCode = code;
} finally {
  webProcess?.kill('SIGTERM');
}

function run(command, args, cwd, env = process.env) {
  const isExe = typeof command === 'string' && command.toLowerCase().endsWith('.exe');
  const useShell = isWin && !isExe;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: useShell
    });
    child.once('error', reject);
    child.once('exit', code => resolvePromise(code ?? 1));
  }).then(code => {
    if (code !== 0) throw new Error(`${command} exited with code ${code}`);
    return code;
  });
}

function isPortOpen(port) {
  return new Promise(resolvePromise => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(250);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    const close = () => {
      socket.destroy();
      resolvePromise(false);
    };
    socket.once('timeout', close);
    socket.once('error', close);
  });
}

async function waitForPort(port, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port)) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Timed out waiting for 127.0.0.1:${port}`);
}
