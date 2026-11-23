// The interactive layer: glass, breath, seeds, and the readout.
//
// Layout is resolution-independent. The simulation runs on a fixed logical grid
// (GRID_W x GRID_H aspect-locked to the viewport) and the canvas bitmap is that
// grid; CSS scales it. Detail in frost comes from the field, so like the mudflat
// study the limit is cell count, not bitmap size -- but frost is soft and feathery,
// so it survives upscaling far better than hard terrain normals did.
import {
  createWorld, step, seedCrystal, breathPatch, chill,
  solidFraction, meanUndercooling,
} from './sim.js';

const GRID_W = 720;
const CHILL_PER_STEP = 0.0035;
const BREATH_RADIUS = 46;
const BREATH_STRENGTH = 0.9;
const STEPS_PER_FRAME = 3;

export function mount(els) {
  const { canvas, btnBreath, btnSeed, btnClear, readFrost, readFuel, note } = els;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let W = GRID_W;
  let H = Math.round(GRID_W * 0.62);
  let world = freshWorld();
  let img = null;

  function freshWorld() {
    return createWorld(W, H, {});
  }

  function resize() {
    // Portrait and landscape both need to fill without stretching the physics cells
    // into rectangles, otherwise growth is anisotropic for no physical reason.
    const aspect = window.innerHeight / window.innerWidth;
    W = GRID_W;
    H = Math.max(160, Math.round(GRID_W * Math.min(1.5, Math.max(0.5, aspect))));
    canvas.width = W;
    canvas.height = H;
    world = freshWorld();
    img = ctx.createImageData(W, H);
    prime();
  }

  // Start with frost already growing from many nuclei. Dense seeding is what turns
  // this from "two blobs" into frost: neighbouring fronts run out of fuel against
  // each other and flatten into the polygonal cells real hoar is made of. The pane is
  // never an empty rectangle, which is the difference between a demo and a picture.
  // Nuclei per unit area, so a tall portrait field gets as many as a landscape one.
  // A fixed count left portrait as sparse confetti with most of the pane empty.
  const NUCLEI_PER_10K_CELLS = 6.8;
  function prime() {
    world.u.fill(0.75);
    const nuclei = Math.round(NUCLEI_PER_10K_CELLS * (W * H) / 10000);
    for (let i = 0; i < nuclei; i++) {
      // Deterministic jitter so the mosaic is reproducible for a given size.
      const a = Math.sin(i * 12.9898) * 43758.5453;
      const b2 = Math.sin(i * 78.233) * 12345.6789;
      const rx = a - Math.floor(a);
      const ry = b2 - Math.floor(b2);
      seedCrystal(world, rx * W, ry * H, 1.6 + 1.4 * rx);
    }
  }

  // --- input -------------------------------------------------------------
  // Dragging or holding breath removes undercooling where the finger points and
  // deposits water. Releasing lets the cold glass pull the heat back out.
  let breathing = false;
  let hasInteracted = false;
  let announcedFull = false;
  let noteCleared = false;

  function breathAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    const y = ((clientY - r.top) / r.height) * H;
    breathPatch(world, x, y, BREATH_RADIUS, BREATH_STRENGTH);
  }

  canvas.addEventListener('pointerdown', (ev) => {
    hasInteracted = true;
    breathing = true;
    canvas.setPointerCapture(ev.pointerId);
    breathAt(ev.clientX, ev.clientY);
    ev.preventDefault();
  }, { passive: false });
  canvas.addEventListener('pointermove', (ev) => {
    if (breathing) breathAt(ev.clientX, ev.clientY);
  }, { passive: true });
  const stop = () => { breathing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);

  // Double-tap / double-click nucleates a crystal: a second, distinct verb on the
  // same surface, so the glass is not only something you wipe.
  canvas.addEventListener('dblclick', (ev) => {
    hasInteracted = true;
    const r = canvas.getBoundingClientRect();
    seedCrystal(world, ((ev.clientX - r.left) / r.width) * W,
      ((ev.clientY - r.top) / r.height) * H, 2.5);
  });

  btnBreath.addEventListener('click', () => {
    hasInteracted = true;
    // A no-aim option for touch users: breathe across the whole pane.
    for (let k = 0; k < world.n; k++) world.u[k] = Math.max(0, world.u[k] - 0.35);
  });
  btnSeed.addEventListener('click', () => {
    hasInteracted = true;
    seedCrystal(world, W * (0.2 + 0.6 * Math.random()), H * (0.2 + 0.6 * Math.random()), 2.5);
  });
  btnClear.addEventListener('click', () => {
    hasInteracted = true; announcedFull = false; prime(); noteText('wiped clean \u2014 the glass is clearing'); });

  // --- render ------------------------------------------------------------
  // Frost is drawn as ice over cold glass. The undercooling field is shown as a
  // faint blue haze so users can see the fuel being consumed around the ice, which
  // is the point of the whole model; without it the competition is invisible.
  function draw() {
    const d = img.data;
    const { phi, u, W, H } = world;
    for (let j = 0; j < H; j++) {
      const jm = j > 0 ? j - 1 : j;
      const jp = j < H - 1 ? j + 1 : j;
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const kl = j * W + ((i - 1 + W) % W);
        const kr = j * W + ((i + 1) % W);
        const t = (phi[k] + 1) * 0.5;
        const fuel = u[k] > 1 ? 1 : u[k];
        // Cold glass: a blue that visibly dims as the film gives up its cold, so the
        // haze is a real gauge and not decoration.
        let r = 10 + fuel * 22;
        let g = 15 + fuel * 40;
        let b = 30 + fuel * 66;
        if (t > 0.42) {
          const q = (t - 0.42) / 0.58;
          // Interface strength: bright where the front is actively advancing, which
          // traces the boundary of every cell and gives the sheet its crystalline
          // web. Mature interior stays darker so cells remain distinguishable --
          // a flat white sheet reads as cotton wool, which is the failure here.
          const gx = (phi[kr] - phi[kl]) * 0.5;
          const gy = (phi[jp * W + i] - phi[jm * W + i]) * 0.5;
          const edge = Math.min(1, Math.hypot(gx, gy) * 5.5);
          // Slightly blue-shifted, so the web reads cool rather than chalky.
          const body = 0.55 + 0.45 * q;
          r = 62 + 150 * body * (0.55 + 0.45 * edge);
          g = 84 + 146 * body * (0.55 + 0.45 * edge);
          b = 112 + 130 * body * (0.62 + 0.38 * edge);
          // Fuel just behind the front glows faintly: growth consumed it there.
          const spent = 1 - Math.min(1, u[k]);
          r += spent * 12; g += spent * 16; b += spent * 10;
        }
        const o = k * 4;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function noteText(s) {
    note.textContent = s;
    lastNoteAt = performance.now();
  }

  // Undercooling is capped: unbounded chill outran growth and the pane just got
  // colder without frosting (observed: fuel climbed past 4 while frost stayed at 2%).
  // The cap also makes the readout mean something -- 1.0 is "as cold as this film
  // gets", so the number is a fraction of the cold reservoir, not an arbitrary scale.
  const U_MAX = 1.1;
  function reframe() {
    for (let k = 0; k < world.n; k++) if (world.u[k] > U_MAX) world.u[k] = U_MAX;
  }

  function frame() {
    for (let i = 0; i < STEPS_PER_FRAME; i++) {
      chill(world, CHILL_PER_STEP);
      step(world, null);
      reframe();
    }
    draw();
    const f = solidFraction(world);
    readFrost.textContent = Math.round(f * 100) + '%';
    readFuel.textContent = Math.round((meanUndercooling(world) / U_MAX) * 100) + '%';
    // One place decides what the note says. On arrival it is the instruction; after
    // the first interaction it goes quiet unless something worth saying happened.
    if (!hasInteracted) {
      note.textContent = 'Drag across the glass to breathe on it \u00b7 double-tap to seed a crystal';
    } else if (!noteCleared) {
      noteCleared = true;
      note.textContent = '';
    } else if (f > 0.98 && !announcedFull) {
      announcedFull = true;
      noteText('the glass is fully frosted');
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
  return { get world() { return world; } };
}
