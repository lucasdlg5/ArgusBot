import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

process.env.ARGUS_RENDER_SERVER = '1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const bundlePath = resolve(rootDir, 'dist', 'render-server.mjs');
const bootStart = Date.now();

console.log(`[ArgusBoot] Starting moneta-argus-bot (node ${process.version}, pid ${process.pid})...`);

if (existsSync(bundlePath)) {
  console.log(`[ArgusBoot] Loading pre-compiled bundle dist/render-server.mjs...`);
  await import(pathToFileURL(bundlePath).href);
  console.log(`[ArgusBoot] Bundle imported in ${Date.now() - bootStart}ms`);
} else {
  console.log(`[ArgusBoot] Pre-compiled bundle not found; falling back to tsx src/bot/render-server.ts...`);
  const isWin = process.platform === 'win32';
  const child = spawn(
    isWin ? 'npx.cmd' : 'npx',
    ['tsx', 'src/bot/render-server.ts'],
    { cwd: rootDir, stdio: 'inherit', env: process.env }
  );
  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}
