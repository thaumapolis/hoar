// Shared browser bootstrap. Fails loudly if the toolchain is absent, so a missing
// browser cannot be mistaken for a passing suite.
const entry = process.env.PLAYWRIGHT_ENTRY;
if (!entry) throw new Error('PLAYWRIGHT_ENTRY is not set -- source /tmp/agent/lodex/env.sh');
const mod = await import(entry);
const BROWSER = process.env.HOAR_BROWSER || 'firefox';
export const ROOT = new URL('..', import.meta.url).pathname;
export const ARTIFACT = 'file://' + ROOT + 'index.html';
export const { chromium, firefox } = mod;
if (!mod[BROWSER]) throw new Error('browser "' + BROWSER + '" not available from playwright entry');

export async function withBrowser(fn) {
  // mod.firefox is a BrowserType; the launcher is its .launch method. Destructuring
  // the browser out of mod and calling it directly is not a launcher.
  const browserType = { chromium: mod.chromium, firefox: mod.firefox }[BROWSER];
  if (!browserType || typeof browserType.launch !== 'function') {
    throw new Error('playwright entry has no launchable "' + BROWSER + '"');
  }
  const b = await browserType.launch();
  try { return await fn(b); } finally { await b.close(); }
}

export async function openPage(browser, viewport, opts = {}) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: !!opts.mobile,
    hasTouch: !!opts.mobile,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(ARTIFACT, { waitUntil: 'load' });
  return { ctx, page, errors };
}

export function assertNoErrors(errors, label) {
  if (errors.length) throw new Error(label + ': unexpected page errors -> ' + errors.join(' | '));
}
