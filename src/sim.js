// Frost growing on cold glass.
//
// Two coupled fields on a grid:
//   phi in [-1,1]  phase: +1 ice, -1 open glass. phi = 0 is the interface.
//   u in [0,~3]    undercooling of the thin water film: how far below freezing it is.
//                  This is the fuel. Ice grows only where u > 0.
//
//   tau dphi/dt = eps^2 div(a(n) grad phi) + (phi - phi^3) + 2*sqrt(2) u (1 - phi^2)
//   du/dt       = D lap u + L dphi/dt - sink
//
// What makes this more than a growing-circle animation is the coupling: freezing
// releases latent heat (L term) which destroys the undercooling that let the crystal
// grow. So every crystal digs a hollow in its own fuel supply, neighbours compete for
// the same film, and growth front speed is set by who can reach fresh undercooling
// first. Where two fronts meet, they stop: neither has fuel left between them. That is
// why frost forms polygonal cells with straight shared edges, which is the same
// mechanism as recrystallisation in metals, and it is what the user sees.
//
// Numerics: explicit Euler on a parabolic system. dtLimit gives the diffusive
// stability bound and createWorld refuses a dt above it, so an unstable configuration
// is a construction error rather than a field full of NaNs that renders as black
// through Uint8ClampedArray.

export const DEFAULTS = {
  tau: 1.0,
  eps: 1.3,
  anis: 0.0,
  dt: 0.005,
  latent: 0.45,
  diffusivity: 1.0,
  uMelt: 0.25,
};

export function dtLimit(p) {
  return 0.35 * p.tau / (4 * p.eps * p.eps + 1e-12);
}

export function createWorld(W, H, opts) {
  const p = { ...DEFAULTS, ...(opts || {}) };
  if (!(W >= 16 && H >= 16)) throw new Error('grid too small');
  if (!(p.dt > 0)) throw new Error('dt must be positive');
  if (p.dt > dtLimit(p)) {
    throw new Error('dt=' + p.dt + ' exceeds stability limit ' + dtLimit(p).toFixed(5));
  }
  const n = W * H;
  return {
    W, H, n, p,
    phi: new Float64Array(n).fill(-1),
    u: new Float64Array(n),
    nextPhi: new Float64Array(n),
    nextU: new Float64Array(n),
    steps: 0,
  };
}

const SQ2 = 2 * Math.SQRT2;

// Advance one step. `breath` is an optional per-cell array of undercooling
// removal (warm moist breath raises the surface and eats the fuel); pass null
// when the user is not breathing.
export function step(w, breath) {
  const { W, H, n, p, phi, u, nextPhi, nextU } = w;
  const eps2 = p.eps * p.eps;
  for (let j = 0; j < H; j++) {
    const jm = j > 0 ? j - 1 : j;
    const jp = j < H - 1 ? j + 1 : j;
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const kl = j * W + ((i - 1 + W) % W);
      const kr = j * W + ((i + 1) % W);
      const ku = jm * W + i;
      const kd = jp * W + i;

      const ph = phi[k];
      let stiff = 1;
      if (p.anis > 0) {
        const gx = (phi[kr] - phi[kl]) * 0.5;
        const gy = (phi[kd] - phi[ku]) * 0.5;
        stiff = 1 - p.anis * Math.cos(4 * Math.atan2(gy, gx));
        if (!(stiff > 0.05)) throw new Error('anisotropy stiffness non-positive: anis too large');
      }
      const lapPhi = stiff * (phi[kl] + phi[kr] + phi[ku] + phi[kd] - 4 * ph);
      const bulk = ph - ph * ph * ph;
      // The driving term is signed, so a warm film (u below the melting point of this
      // discretisation, U_MELT) pushes the front back toward liquid: ice that is
      // breathed on melts rather than merely stalling. Without this, removing fuel is
      // nearly inert and the headline mechanic is invisible (measured: breath strength
      // 0.14 vs 0.6 changed coverage by 0.005).
      const thermal = SQ2 * (u[k] - p.uMelt) * (1 - ph * ph);
      const dphi = (eps2 * lapPhi + bulk + thermal) / p.tau;
      nextPhi[k] = ph + p.dt * dphi;

      const lapU = u[kl] + u[kr] + u[ku] + u[kd] - 4 * u[k];
      let nextUv = u[k] + p.dt * (p.diffusivity * lapU + p.latent * dphi);
      // breath is a per-step rate in the same units as chill(), so it is subtracted
      // directly. Scaling it by dt as well made warm breath ~200x too weak to
      // counteract the latent heat it is supposed to overwhelm.
      if (breath) nextUv -= breath[k];
      if (nextUv < 0) nextUv = 0;
      nextU[k] = nextUv;
    }
  }
  for (let k = 0; k < n; k++) {
    const ph = nextPhi[k];
    const uu = nextU[k];
    if (!(Number.isFinite(ph) && Number.isFinite(uu))) {
      throw new Error('non-finite field at step ' + w.steps + ' cell ' + k);
    }
    phi[k] = ph < -1.05 ? -1.05 : ph > 1.05 ? 1.05 : ph;
    u[k] = uu;
  }
  w.steps++;
  return w;
}

export function seedCrystal(w, cx, cy, radius) {
  const { W, H, phi } = w;
  if (!(Number.isFinite(cx) && Number.isFinite(cy))) throw new Error('seed centre must be finite');
  if (!(radius > 0)) throw new Error('seed radius must be positive');
  // "Outside the field" means the centre is outside the grid. The earlier form of this
  // check counted cells whose tanh profile improved on phi, which is zero for a seed
  // dropped on already-frozen glass -- a legitimate request, not a bad coordinate, and
  // it threw twice in ways that looked like geometry bugs.
  if (!(cx >= 0 && cx < W && cy >= 0 && cy < H)) {
    throw new Error('seed centre outside the field: ' + cx + ',' + cy);
  }
  // Only the seed's own neighbourhood can change: tanh saturates a few interface
  // widths out, so scanning the whole field per nucleus made seeding O(nuclei x n).
  // At ~1000 nuclei on a 1200x750 grid that was 6 s of blocked startup, and it also
  // made the "New crystal" button hesitate.
  const reach = radius + 8;
  const i0 = Math.max(0, Math.floor(cx - reach)), i1 = Math.min(W - 1, Math.ceil(cx + reach));
  const j0 = Math.max(0, Math.floor(cy - reach)), j1 = Math.min(H - 1, Math.ceil(cy + reach));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i - cx, j - cy);
      const t = Math.tanh((radius - d) / 1.2);
      const k = j * W + i;
      if (t > phi[k]) phi[k] = t;
    }
  }
  return w;
}

// Deposit liquid water on the glass without changing its temperature: this is what
// "breathing" does -- moist air condenses, and the film is initially at 0 undercooling.
// Undercooling is only restored by the cold glass drawing heat out (see chill).
export function deposit(w, cx, cy, radius, amount) {
  return wetnessPatch(w, cx, cy, radius, amount);
}

// The glass is cold and pulls heat out of the film, restoring undercooling.
// Rate is per step; this is what lets the frost survive at all.
export function chill(w, rate) {
  if (!(Number.isFinite(rate) && rate >= 0)) throw new Error('chill rate must be >= 0');
  for (let k = 0; k < w.n; k++) w.u[k] += rate;
  return w;
}

// Warm, wet breath: removes undercooling locally and adds water.
export function breathPatch(w, cx, cy, radius, strength) {
  return wetnessPatch(w, cx, cy, radius, strength);
}

function wetnessPatch(w, cx, cy, radius, amount) {
  const { W, H, u } = w;
  if (!(radius > 0)) throw new Error('patch radius must be positive');
  if (!Number.isFinite(amount)) throw new Error('patch amount must be finite');
  const r2 = radius * radius;
  const i0 = Math.max(0, Math.floor(cx - radius)), i1 = Math.min(W - 1, Math.ceil(cx + radius));
  const j0 = Math.max(0, Math.floor(cy - radius)), j1 = Math.min(H - 1, Math.ceil(cy + radius));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d2 = (i - cx) * (i - cx) + (j - cy) * (j - cy);
      if (d2 > r2) continue;
      const falloff = 1 - Math.sqrt(d2) / radius;
      const k = j * W + i;
      u[k] = Math.max(0, u[k] - amount * falloff);
    }
  }
  return w;
}

export function solidFraction(w) {
  let s = 0;
  for (let k = 0; k < w.n; k++) if (w.phi[k] > 0) s++;
  return s / w.n;
}

export function meanUndercooling(w) {
  let s = 0;
  for (let k = 0; k < w.n; k++) s += w.u[k];
  return s / w.n;
}
