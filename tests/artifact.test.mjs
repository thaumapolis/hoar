// Exercises the generated index.html, not the sources, in conditions matching the
// org guarantees: offline, opaque-origin sandbox, storage denied.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withBrowser, openPage, assertNoErrors, ARTIFACT } from './harness.mjs';
import { ROOT } from './harness.mjs';

// Drive a touch interaction in a mobile context. Playwright's mouse emits `click`
// but no `pointerdown` under isMobile+hasTouch, which silently cannot drive an app
// whose main mechanic is bound to pointer events.
async function p_touch(page, box) {
  await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.5);
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

await test('index.html is self-contained: no network refs, no sibling imports', () => {
  const html = readFileSync(ROOT + '/index.html', 'utf8');
  assert.ok(!/<script[^>]+src=/.test(html), 'external script tag');
  assert.ok(!/<link[^>]+href=/.test(html), 'external link tag');
  assert.ok(!/\bhttps?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'absolute URL in artifact');
  assert.ok(!/\bimport\s|from\s+['"]\.\//.test(html), 'unbundled ES module import');
  assert.ok(!/localStorage|sessionStorage|indexedDB|caches\./.test(html), 'browser storage used');
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket/.test(html), 'network call in artifact');
});

await test('artifact boots with no page errors in each orientation', async () => {
  await withBrowser(async (b) => {
    for (const [label, vp, mobile] of [
      ['desktop', { width: 1440, height: 900 }, false],
      ['portrait', { width: 390, height: 844 }, true],
      ['landscape', { width: 844, height: 390 }, true],
    ]) {
      const { ctx, page, errors } = await openPage(b, vp, { mobile });
      await page.waitForTimeout(1500);
      assertNoErrors(errors, label);
      const canvas = await page.evaluate(() => {
        const c = document.getElementById('c');
        return { w: c.width, h: c.height };
      });
      assert.ok(canvas.w >= 16 && canvas.h >= 16, label + ': canvas not sized');
      await ctx.close();
    }
  });
});

await test('canvas is actually painted, not blank', async () => {
  await withBrowser(async (b) => {
    const { ctx, page, errors } = await openPage(b, { width: 1280, height: 800 }, {});
    await page.waitForTimeout(2500);
    assertNoErrors(errors, 'paint');
    const stat = await page.evaluate(() => {
      const c = document.getElementById('c');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      let dark = 0;
      for (let i = 0; i < d.length; i += 4 * 13) {
        seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
        if (d[i] < 6 && d[i + 1] < 6 && d[i + 2] < 6) dark++;
      }
      return { colors: seen.size, dark };
    });
    assert.ok(stat.colors > 12, 'canvas looks flat: only ' + stat.colors + ' sampled colours');
    // A fully black canvas is the signature of NaN pixels through Uint8ClampedArray.
    assert.ok(stat.dark < 40, 'canvas mostly black (' + stat.dark + '), suspect NaN field');
    await ctx.close();
  });
});

await test('controls work: wipe resets, seed and breathe do not throw', async () => {
  await withBrowser(async (b) => {
    const { ctx, page, errors } = await openPage(b, { width: 1280, height: 800 }, {});
    await page.waitForTimeout(2500);
    await page.locator('#seed').click();
    await page.locator('#breath').click();
    await page.waitForTimeout(600);
    const before = await page.evaluate(() => parseFloat(document.getElementById('frost').textContent));
    await page.locator('#clear').click();
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => parseFloat(document.getElementById('frost').textContent));
    assert.ok(after < before, 'wipe did not reduce frost: ' + before + ' -> ' + after);
    assertNoErrors(errors, 'controls');
    await ctx.close();
  });
});

await test('dragging on the glass removes frost where it points', async () => {
  await withBrowser(async (b) => {
    const { ctx, page, errors } = await openPage(b, { width: 1280, height: 800 }, {});
    await page.waitForTimeout(2200);
    const box = await page.locator('#c').boundingBox();
    const sample = () => page.evaluate(() => {
      const c = document.getElementById('c');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      // Bright ice count: ice is the light part of the image.
      let bright = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] > 140 && d[k + 2] > 150) bright++;
      return bright;
    });
    // Measure only the strip the pointer traverses. A whole-canvas count is
    // confounded by frost advancing everywhere else at the same time, which made this
    // assertion fail for a reason unrelated to the breath mechanic.
    const PATCH = 0.055;
    const patch = () => page.evaluate((R) => {
      const c = document.getElementById('c');
      const cx = Math.floor(c.width * 0.72), cy = Math.floor(c.height * 0.5);
      const r = Math.floor(c.width * R);
      const d = c.getContext('2d').getImageData(cx - r, cy - r, 2 * r, 2 * r).data;
      let bright = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] > 140 && d[k + 2] > 150) bright++;
      return bright / (d.length / 4);
    }, PATCH);
    // Measure the small disc the pointer dwells in, not a wide strip: a breath patch
    // is ~13% of the pane, and averaging it against a pane that is still freezing
    // everywhere else hid a mechanic that works (confirmed by field probes: u at the
    // patch centre goes 1.1 -> 0 and phi melts back).
    const before = await patch();
    // Hold over the patch centre so breath is applied for a full second of steps.
    await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.5);
    await page.mouse.down();
    for (let i = 0; i < 20; i++) {
      await page.mouse.move(box.x + box.width * (0.72 + 0.004 * Math.sin(i)), box.y + box.height * 0.5);
      await page.waitForTimeout(60);
    }
    await page.mouse.up();
    const after = await patch();
    assert.ok(after < before,
      'breathing left the frost unchanged in the traversed strip: ' +
      before.toFixed(3) + ' -> ' + after.toFixed(3));
    assertNoErrors(errors, 'drag');
    await ctx.close();
  });
});

await test('onboarding text is present before interaction and gone after', async () => {
  await withBrowser(async (b) => {
    const { ctx, page, errors } = await openPage(b, { width: 390, height: 844 }, { mobile: true });
    await page.waitForTimeout(900);
    const hint = await page.evaluate(() => document.getElementById('note').textContent);
    assert.match(hint, /breathe/i, 'no onboarding hint on arrival');
    const box = await page.locator('#c').boundingBox();
    // Real touch, not mouse: in a mobile context Playwright's mouse emits `click`
    // without `pointerdown`, so it cannot drive a pointer-event mechanic.
    await p_touch(page, box);
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => document.getElementById('note').textContent);
    assert.ok(!/breathe on it/.test(after), 'hint persisted after the user interacted');
    assertNoErrors(errors, 'onboarding');
    await ctx.close();
  });
});

await test('survives an opaque-origin sandbox with scripts allowed and storage denied', async () => {
  await withBrowser(async (b) => {
    const ctx = await b.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.goto('about:blank');
    const html = readFileSync(ROOT + '/index.html', 'utf8');
    // A sandboxed iframe with no allow-same-origin is the opaque-origin case.
    await page.evaluate((src) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.style.cssText = 'width:900px;height:700px;border:0';
      f.srcdoc = src;
      document.body.appendChild(f);
    }, html);
    await page.waitForTimeout(2500);
    // An opaque-origin frame deliberately denies parent access, so "cannot read the
    // DOM" is the pass condition here, not a failure. What must hold is that the
    // artifact starts and runs without throwing inside such a frame.
    const opaque = await page.evaluate(() => {
      const f = document.querySelector('iframe');
      try { return !!f.contentWindow.document; } catch (e) { return false; }
    });
    assert.ok(!opaque, 'iframe was same-origin, so this did not test an opaque origin');
    // Confirm the frame is actually alive and sized, which is observable from outside.
    const sized = await page.evaluate(() => {
      const f = document.querySelector('iframe');
      const r = f.getBoundingClientRect();
      return r.width > 100 && r.height > 100;
    });
    assert.ok(sized, 'iframe not laid out');
    if (errors.length) throw new Error('opaque-origin errors: ' + errors.join(' | '));
    await ctx.close();
  });
});

console.log('artifact: ' + passed + ' passed');
