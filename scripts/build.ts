import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const dist = resolve(root, 'dist');
const bundler = resolve(root, 'node_modules/.bin/openchamber-guest-bundle');

function bundle(entry: string, out: string, nodeTarget: boolean): void {
  const args = nodeTarget ? ['--node', entry, out] : [entry, out];
  execFileSync(bundler, args, { cwd: root, stdio: 'inherit' });
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(resolve(dist, 'panel'), { recursive: true });
mkdirSync(resolve(dist, 'page'), { recursive: true });
mkdirSync(resolve(dist, 'service'), { recursive: true });
mkdirSync(resolve(root, 'plugin'), { recursive: true });

bundle('src/frame/panel/main.ts', 'dist/panel/main.js', false);
bundle('src/frame/page/main.ts', 'dist/page/main.js', false);
bundle('src/service/main.ts', 'dist/service/main.js', true);
bundle('plugin/src/index.ts', 'plugin/index.js', true);

copyFileSync(resolve(root, 'src/frame/panel/index.html'), resolve(dist, 'panel/index.html'));
copyFileSync(resolve(root, 'src/frame/page/index.html'), resolve(dist, 'page/index.html'));

console.log('Built dist/ and plugin/index.js');
