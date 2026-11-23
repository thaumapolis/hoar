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

// Simulation grid width. Detail in this app is limited by cell count, not by canvas
// CSS size, so a fixed 720 looked soft on a wide desktop and on any 2x display: the
// same field was simply stretched. Sizing the field to the device makes the frost
// crisp where the pixels are, at the cost of more work per step -- hence the cap.
// Grid width budget, chosen by measurement rather than by wanting more detail:
// 1789 cells wide measured 5.9 fps on desktop and 13.5 fps on a phone, which feels
// broken. 960 cells wide (about 1.05M cells with STEPS_PER_FRAME below) holds 60 fps.
const MAX_GRID_CELLS = 1_050_000;
function gridWidthFor(cssW, cssH, dpr) {
  const aspect = Math.min(1.5, Math.max(0.5, cssH / cssW));
  const want = Math.round(cssW * dpr);
  const cells = want * want * aspect;
  const width = cells > MAX_GRID_CELLS
    ? Math.round(want * Math.sqrt(MAX_GRID_CELLS / cells))
    : want;
  return Math.max(360, Math.min(width, 1200));
}
const CHILL_PER_STEP = 0.009;
// Breath patch radius as a fraction of the field width, not a fixed cell count: the
// field is sized to the display, so a fixed 46 cells is proportionally much smaller on
// a 1200-wide grid than on 720, and diffusion then outruns the breath and the mechanic
// stops working on big screens (observed: melts at 600 wide, only slows at 1200).
// 0.075 of the field keeps the same warm fraction of the pane at any size.
const BREATH_RADIUS_FRAC = 0.075;
// Per solver step. 0.14 comfortably exceeds CHILL_PER_STEP, which is what makes a
// held breath win locally; if these two ever approach each other the mechanic stops
// being visible, so they are kept far apart deliberately.
const BREATH_STRENGTH = 0.14;
// Solver steps per animation frame. Measured on this model at a 1200x750 grid:
// 1 step/frame runs at ~55 fps, 6 steps/frame at ~13.5 fps, and the cost is the step
// count rather than the grid size. One step keeps the interaction smooth; the growth
// pace a visitor sees is set by CHILL_PER_STEP and the front speed, not by this.
const STEPS_PER_FRAME = 1;

export function mount(els) {
  // Declared first: resize() -> reset() -> freshWorld() writes breathField, and a
  // `let` below that call site is a temporal-dead-zone error at startup.
  let breathing = false;
  let pointerX = 0, pointerY = 0;
  // Breath is a persistent field, not a one-shot impulse: the frame loop advances
  // several solver steps per frame and re-chills each one, so a single
  // breathPatch() on pointerdown was erased before the ice noticed it. Painting a
  // field the loop consumes every step is what makes the mechanic actually visible.
  let breathField = null;
  let hasInteracted = false;
  let announcedFull = false;
  let noteCleared = false;
  let pendingNote = false;

  const { canvas, btnBreath, btnSeed, btnClear, readFrost, readFuel, note } = els;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let W = 720;
  let H = 450;
  let world = freshWorld();
  let img = null;

  function freshWorld() {
    const w = createWorld(W, H, {});
    breathField = new Float64Array(w.n);
    return w;
  }

  // Paint this frame's breath into the field, then let it decay so a held finger
  // keeps a warm plume while a released one fades.
  function paintBreath() {
    if (!breathField) return;
    breathField.fill(0);
    if (!breathing) return;
    const R = Math.max(12, Math.round(W * BREATH_RADIUS_FRAC)), R2 = R * R;
    const i0 = Math.max(0, Math.floor(pointerX - R)), i1 = Math.min(W - 1, Math.ceil(pointerX + R));
    const j0 = Math.max(0, Math.floor(pointerY - R)), j1 = Math.min(H - 1, Math.ceil(pointerY + R));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i - pointerX, dy = j - pointerY;
        const d2 = dx * dx + dy * dy;
        if (d2 > R2) continue;
        breathField[j * W + i] = BREATH_STRENGTH * (1 - Math.sqrt(d2) / R);
      }
    }
  }

  function resize() {
    // Portrait and landscape both need to fill without stretching the physics cells
    // into rectangles, otherwise growth is anisotropic for no physical reason.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = gridWidthFor(window.innerWidth, window.innerHeight, dpr);
    const aspect = Math.min(1.5, Math.max(0.5, window.innerHeight / window.innerWidth));
    H = Math.max(160, Math.round(W * aspect));
    canvas.width = W;
    canvas.height = H;
    img = ctx.createImageData(W, H);
    reset();
  }

  // Start with frost already growing from many nuclei. Dense seeding is what turns
  // this from "two blobs" into frost: neighbouring fronts run out of fuel against
  // each other and flatten into the polygonal cells real hoar is made of. The pane is
  // never an empty rectangle, which is the difference between a demo and a picture.
  // Nuclei per unit area, so a tall portrait field gets as many as a landscape one.
  // A fixed count left portrait as sparse confetti with most of the pane empty.
  // Nuclei per 10k cells, and the seed radius as a fraction of the field. Both scale
// with the grid so a 1200-wide pane is no sparser than a 720-wide one; with a fixed
// cell radius the same count left big screens reading as scattered dots.
const NUCLEI_PER_10K_CELLS = 26.0;
const SEED_RADIUS_FRAC = 0.0055;
// Preroll sized so startup stays quick whatever the grid resolution: the cost is
// steps x cells, so a fixed step count cost 6.9 s on a 1200x750 grid. Budget is in
// cell-steps; 150 steps on a 720x450 field was the look that reads well, and this
// keeps that much work at any size.
const PREROLL_CELL_BUDGET = 48_000_000;
  function reset() {
    world = freshWorld();
    img = img && img.width === W && img.height === H ? img : ctx.createImageData(W, H);
    seed();
  }

  function seed() {
    world.u.fill(1.05);
    const nuclei = Math.round(NUCLEI_PER_10K_CELLS * (W * H) / 10000);
    for (let i = 0; i < nuclei; i++) {
      // Deterministic jitter so the mosaic is reproducible for a given size.
      const a = Math.sin(i * 12.9898) * 43758.5453;
      const b2 = Math.sin(i * 78.233) * 12345.6789;
      const rx = a - Math.floor(a);
      const ry = b2 - Math.floor(b2);
      seedCrystal(world, rx * W, ry * H, W * SEED_RADIUS_FRAC * (0.7 + 0.9 * rx));
    }
    // A short preroll only. Growing the whole arrival state up front looked better in
    // a screenshot but cost 17.8 s of blocked startup on a 1200x750 grid -- the page
    // was unusable before the first paint, which is a worse defect than a sparse one.
    const preroll = Math.max(20, Math.floor(PREROLL_CELL_BUDGET / world.n));
    for (let i = 0; i < preroll; i++) {
      chill(world, CHILL_PER_STEP);
      step(world, null);
      reframe();
    }
  }

  // --- input -------------------------------------------------------------
  // Dragging or holding breath removes undercooling where the finger points and
  // deposits water. Releasing lets the cold glass pull the heat back out.

  function breathAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    pointerX = ((clientX - r.left) / r.width) * W;
    pointerY = ((clientY - r.top) / r.height) * H;
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
    // Try a few spots: on a pane that is nearly all ice there may be no open glass
    // left, and a button that does nothing is worse than one that says so.
    for (let attempt = 0; attempt < 12; attempt++) {
      const cx = W * (0.08 + 0.84 * Math.random());
      const cy = H * (0.08 + 0.84 * Math.random());
      if (world.phi[Math.floor(cy) * W + Math.floor(cx)] < 0.2) {
        seedCrystal(world, cx, cy, 2.5);
        noteText('new crystal started where the glass was still clear');
        return;
      }
    }
    noteText('no clear glass left to seed \u2014 wipe first');
  });
  btnClear.addEventListener('click', () => {
    hasInteracted = true; announcedFull = false; reset();
    noteText('wiped clean \u2014 the glass is clearing'); });

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
    pendingNote = true;
    note.textContent = s;
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
    paintBreath();
    for (let i = 0; i < STEPS_PER_FRAME; i++) {
      chill(world, CHILL_PER_STEP);
      step(world, breathField);
      reframe();
    }
    // Breath and chill are both per-step rates applied inside the same loop, so they
    // stay balanced whatever STEPS_PER_FRAME is. The balance is what the mechanic
    // depends on: breath only wins locally where it exceeds the glass's pull.
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
      if (!pendingNote) note.textContent = '';
    } else if (f > 0.98 && !announcedFull) {
      announcedFull = true;
      noteText('the glass is fully frosted');
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
  return {
    get world() { return world; },
    // What the pointer is doing and what the breath field holds, so a failing
    // interaction test can say which link in the chain broke.
    isBreathing() { return breathing; },
    breathPeak() {
      if (!breathField) return 0;
      let m = 0;
      for (let k = 0; k < breathField.length; k++) if (breathField[k] > m) m = breathField[k];
      return m;
    },
  };
}
