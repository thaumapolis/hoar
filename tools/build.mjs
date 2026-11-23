// Produce index.html: one self-contained file, no network, no sibling files, no
// storage. The source keeps sim.js/app.js modular for testing; the build flattens
// them into a single classic script (no import/export) so the file also works when
// opened from a URL where module MIME/CORS rules would apply.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Strip ESM plumbing: `export` keywords and the import block. The import is
// replaced by nothing because everything lands in one scope.
function flatten(src) {
  return src
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^export\s+(const|function|class)\b/gm, '$1')
    .replace(/^export\s+/gm, '');
}

const sim = flatten(read('src/sim.js'));
const app = flatten(read('src/app.js'));
const html = read('src/index.html');

const bundle = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>hoar &mdash; breath on cold glass</title>
<style>
${(html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1]}
</style>
</head>
<body>
${(html.match(/<body>([\s\S]*?)<script/)[1]).trim()}
<script>
/* hoar -- dendritic-frost-free phase-field model, bundled. See README for the
   physical model and its stated limits. */
(function () {
'use strict';
${sim}
${app}
window.__hoar = { createWorld, step, seedCrystal, breathPatch, chill, solidFraction, meanUndercooling };
mount({
  canvas: document.getElementById('c'),
  btnBreath: document.getElementById('breath'),
  btnSeed: document.getElementById('seed'),
  btnClear: document.getElementById('clear'),
  readFrost: document.getElementById('frost'),
  readFuel: document.getElementById('fuel'),
  note: document.getElementById('note'),
});
})();
</script>
</body>
</html>
`;

writeFileSync(join(root, 'index.html'), bundle);
console.log('wrote index.html', bundle.length, 'bytes');
