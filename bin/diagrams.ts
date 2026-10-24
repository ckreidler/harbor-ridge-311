import * as fs from 'node:fs';
import * as path from 'node:path';
import { flowPages } from '../lib/flow/pages';

const directory = path.join(process.cwd(), 'docs/flows');
fs.mkdirSync(directory, { recursive: true });
for (const page of flowPages()) {
  fs.writeFileSync(path.join(directory, `${page.name}.md`), page.body);
}
