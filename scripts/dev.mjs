#!/usr/bin/env node
/**
 * Run the API and the web app together.
 *
 * `npm run dev --workspaces` runs workspace scripts one after another, and the
 * API's watcher never exits - so the web dev server would never start. This
 * spawns both, prefixes their output, and shuts both down together. No
 * dependency: one small script beats adding a process runner to the tree.
 */
import { spawn } from 'node:child_process';

// npm tells child scripts where its own CLI lives; running that with the
// current node avoids a shell (and the escaping problems that come with one).
const npmCli = process.env.npm_execpath;
const launcher = npmCli
  ? { command: process.execPath, prefix: [npmCli] }
  : { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };

const services = [
  { name: 'api', color: '[36m', args: ['run', 'dev', '-w', 'server'] },
  { name: 'web', color: '[35m', args: ['run', 'dev', '-w', 'web'] },
];
const RESET = '[0m';
const useColor = process.stdout.isTTY;

const children = services.map((service) => {
  const child = spawn(launcher.command, [...launcher.prefix, ...service.args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: launcher.prefix.length === 0 && process.platform === 'win32', // npm.cmd needs a shell
  });
  const label = useColor ? `${service.color}[${service.name}]${RESET}` : `[${service.name}]`;
  const prefix = (stream) => {
    stream.setEncoding('utf8');
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) console.log(`${label} ${line}`);
    });
  };
  prefix(child.stdout);
  prefix(child.stderr);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(`${label} exited (${signal ?? code}) - stopping the other process`);
    shutdown(typeof code === 'number' ? code : 1);
  });
  return child;
});

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  // Give the children a moment to go down cleanly, then leave.
  setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('Starting Verso: API on http://localhost:4000, web on http://localhost:5173 (Ctrl+C stops both)');
