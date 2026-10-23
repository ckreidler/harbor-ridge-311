import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  build: {
    outDir: resolve(root, '../.website-build'),
    emptyOutDir: true,
    rolldownOptions: {
      input: [resolve(root, 'index.html'), resolve(root, '404.html')],
    },
  },
});
