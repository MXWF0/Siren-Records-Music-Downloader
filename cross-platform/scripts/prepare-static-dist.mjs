import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../dist/index.html', import.meta.url);
let html = await readFile(file, 'utf8');

// A classic script can be opened from file:// in Edge without module CORS checks.
html = html
  .replace(/<script type="module" crossorigin /g, '<script defer ')
  .replace(/ crossorigin(?=[ >])/g, '');

await writeFile(file, html, 'utf8');
