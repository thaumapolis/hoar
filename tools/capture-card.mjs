/**
 * tools/capture-card.mjs -- paint the showcase card, docs/card.png.
 *
 * The front page builds each card at 2:1 (thaumapolis.github.io
 * tools/make_thumbs.py: THUMB_ASPECT). A centre crop of the 1280x800 page
 * screenshot lands on the middle of the ice and drops the HUD, so capture the
 * canvas itself at 2:1: no chrome, nothing to hide.
 *
 * The card must show frost in mid-growth -- enough coverage that the crystalline
 * web reads at card size, but not a saturated white pane, which is the failure
 * mode for this project (an almost-frozen screenshot is a white rectangle).
 * Coverage is therefore driven to a target band by clicking the app's own seed
 * control and reading the app's own readout, not by sleeping: the same
 * precondition pattern that made the breath test machine-independent.
 *
 *   node tools/capture-card.mjs
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.PLAYWRIGHT_ENTRY;
if (!entry) {
  process.stderr.write('PLAYWRIGHT_ENTRY is not set. Run under `nix develop`.\n');
  process.exit(1);
}
const { firefox } = await import(entry);

const CARD_W = 1400;
const CARD_H = CARD_W / 2;
const TARGET_MIN = 55;
const TARGET_MAX = 72;

const b = await firefox.launch();
const ctx = await b.newContext({
  viewport: { width: CARD_W, height: CARD_H },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'load' });

// Grow frost by nucleating through the exposed simulation API, then hide the page
// furniture. Hiding first would make the seed button unclickable (it lives in the
// footer), which is how the first version of this script hung for 30s per click.
let cover = 0;
for (let i = 0; i < 60; i++) {
  cover = await page.evaluate(() => parseFloat(document.getElementById('frost').textContent));
  if (cover >= TARGET_MIN) break;
  // The app's own control, so the pose is reachable by a visitor, not only by a
  // harness with privileged access to the simulation.
  await page.locator('#seed').click();
  await page.waitForTimeout(250);
}
if (cover < TARGET_MIN) throw new Error('could not reach target coverage: ' + cover);

await page.addStyleTag({ content: 'header, footer, #hud, #note { display: none !important; }' });

// Report the pose so a surprising card can be explained rather than guessed at.
const pose = await page.evaluate(() => {
  const c = document.getElementById('c');
  return { frost: document.getElementById('frost').textContent, grid: c.width + 'x' + c.height };
});
console.log('card pose:', JSON.stringify(pose), 'viewport', CARD_W + 'x' + CARD_H);
if (errors.length) throw new Error('page errors during capture: ' + errors.join(' | '));

mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
await page.screenshot({ path: path.join(ROOT, 'docs', 'card.png') });
await b.close();
console.log('wrote docs/card.png');
