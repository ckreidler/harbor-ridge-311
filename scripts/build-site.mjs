import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.website-build');
const bundle = path.join(root, 'node_modules/@amazon-connect-touchpoint/web/lib/index.umd.js');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of ['index.html', '404.html', 'styles.css', 'launch.js']) {
  cpSync(path.join(root, 'website', file), path.join(out, file));
}
cpSync(bundle, path.join(out, 'touchpoint.umd.js'));
