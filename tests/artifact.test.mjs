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

await test('breathing melts frost where it points', async () => {
  await withBrowser(async (b) => {
    const { ctx, page, errors } = await openPage(b, { width: 1280, height: 800 }, {});
    const box = await page.locator('#c').boundingBox();

    // Sample where the ice actually is, and breathe there. Sampling the pane centre
    // failed for the wrong reason: a diagnostic read showed the centre was already
    // liquid (phi = -1), so the test was measuring frost growing into open glass and
    // calling it "breath did nothing". Ask the simulation for an icy cell instead.
    const PATCH = 0.05;
    const aim = () => page.evaluate(() => {
      const w = window.__hoar.app().world;
      // Deterministic pick: the first sufficiently-solid cell in a spiral from the
      // middle, so the sample point is a property of the state, not of a random draw.
      const cx0 = Math.floor(w.W / 2), cy0 = Math.floor(w.H / 2);
      for (let rad = 0; rad < Math.max(w.W, w.H); rad += 6) {
        for (let a = 0; a < 36; a++) {
          const x = Math.round(cx0 + rad * Math.cos((a * Math.PI) / 18));
          const y = Math.round(cy0 + rad * Math.sin((a * Math.PI) / 18));
          if (x < 10 || y < 10 || x >= w.W - 10 || y >= w.H - 10) continue;
          if (w.phi[y * w.W + x] > 0.8) return { x, y, w: w.W, h: w.H };
        }
      }
      return null;
    });
    const patchAt = (pt) => page.evaluate(({ x, y, R }) => {
      const c = document.getElementById('c');
      const r = Math.floor(c.width * R);
      const d = c.getContext('2d').getImageData(x - r, y - r, 2 * r, 2 * r).data;
      let bright = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] > 140 && d[k + 2] > 150) bright++;
      return bright / (d.length / 4);
    }, { x: pt.x, y: pt.y, R: PATCH });

    // Grow frost to a known-covered state first, by seeding until the centre region is
    // icy, rather than waiting a fixed time. A fixed wait made this test depend on how
    // fast the machine renders: CI sampled before the front reached the patch and the
    // assertion compared "not yet frozen" against "slightly frozen" (0.084 -> 0.091).
    const cover = () => page.evaluate(() => parseFloat(document.getElementById('frost').textContent));
    let guard = 0;
    while ((await cover()) < 40 && guard++ < 30) {
      await page.locator('#seed').click();
      await page.waitForTimeout(400);
    }
    assert.ok(await cover() >= 40, 'could not reach a covered pane; coverage ' + await cover());

    const pt = await aim();
    assert.ok(pt, 'no solid ice anywhere to aim at');
    // Map simulation coordinates onto the canvas element for pointer input.
    const box2 = await page.locator('#c').boundingBox();
    const sx = box2.x + (pt.x / pt.w) * box2.width;
    const sy = box2.y + (pt.y / pt.h) * box2.height;

    let before = await patchAt(pt);
    guard = 0;
    while (before < 0.2 && guard++ < 15) {
      await page.waitForTimeout(500);
      before = await patchAt(pt);
    }
    assert.ok(before >= 0.2, 'patch never froze enough to melt: ' + before.toFixed(3));

    // Hold breath over the patch until it measurably melts. Melting is not instant:
    // the held breath first has to refill the patch with warm water against diffusion
    // from the surrounding cold, and only then does the ice retreat. Measured in the
    // model at these settings, coverage falls from 0.306 to 0.222 over ~300 steps, so
    // a short dwell sees growth and nothing else. Iterate until it works or the budget
    // runs out, so the failure message says "never melted" rather than looking like a
    // flaky pixel count.
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    let after = before;
    for (let i = 0; i < 90 && after >= before; i++) {
      await page.mouse.move(sx + 0.5 * Math.sin(i), sy);
      await page.waitForTimeout(80);
      after = await patchAt(pt);
    }
    await page.mouse.up();
    assert.ok(after < before,
      'breathing did not melt the frost under the pointer: ' +
      before.toFixed(3) + ' -> ' + after.toFixed(3));
    assertNoErrors(errors, 'breath');
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
