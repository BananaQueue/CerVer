// LeafCode synthetic image-degradation functions, used by the Gate B
// measurement harness to quantify how much damage the decoder tolerates.
//
// Every export takes an RGBA image `{ width, height, data }` and returns a
// NEW image of the same shape -- the input is never mutated (harness tests
// run several conditions against fresh rasterizations, but functions may
// also be composed, so mutation-safety matters here too). All four treat
// R/G/B identically (the decoder only ever looks at grayscale/threshold), so
// outputs stay achromatic with alpha pinned to 255, matching what raster.js
// produces.

// Box blur: replace each pixel with the mean of the (2*radius+1)^2 window
// around it, clamped at the image edges (no wraparound, no out-of-bounds
// read). radius <= 0 is a no-op copy.
export function blur(img, radius = 1) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data.length);
  const k = Math.max(0, Math.floor(radius));
  if (k === 0) {
    out.set(data);
    return { width: w, height: h, data: out };
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -k; dy <= k; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -k; dx <= k; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          s += data[(ny * w + nx) * 4];
          c++;
        }
      }
      const v = s / c;
      const o = (y * w + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// Rotate about the image centre by `deg` degrees (positive = counter-
// clockwise in standard math convention on a y-down raster, i.e. visually
// clockwise on screen -- direction is irrelevant to the measurement since
// the decoder recovers an arbitrary affine map). Inverse-sampled with
// nearest-neighbour lookup; anything landing outside the source image is
// filled white, matching the rasterizer's background.
export function rotate(img, deg) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.round(cos * (x - cx) + sin * (y - cy) + cx);
      const sy = Math.round(-sin * (x - cx) + cos * (y - cy) + cy);
      const o = (y * w + x) * 4;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
        out[o] = out[o + 1] = out[o + 2] = 255;
        out[o + 3] = 255;
        continue;
      }
      const so = (sy * w + sx) * 4;
      out[o] = data[so];
      out[o + 1] = data[so + 1];
      out[o + 2] = data[so + 2];
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// Downsample by `factor` (nearest-neighbour decimation) then upsample back
// to the original width/height (nearest-neighbour magnification), so the
// output image is the same size as the input but has genuinely lost
// resolution -- the decoder sees the same pixel count with less real detail,
// as it would from a low-resolution camera capture. factor <= 1 is a no-op
// copy.
export function scaleDown(img, factor) {
  const { width: w, height: h, data } = img;
  if (!(factor > 1)) {
    return { width: w, height: h, data: new Uint8ClampedArray(data) };
  }
  const nw = Math.max(1, Math.round(w / factor));
  const nh = Math.max(1, Math.round(h / factor));
  const small = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x * factor));
      const sy = Math.min(h - 1, Math.floor(y * factor));
      const so = (sy * w + sx) * 4;
      const o = (y * nw + x) * 4;
      small[o] = data[so];
      small[o + 1] = data[so + 1];
      small[o + 2] = data[so + 2];
      small[o + 3] = 255;
    }
  }
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(nh - 1, Math.floor(y / factor));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(nw - 1, Math.floor(x / factor));
      const so = (sy * nw + sx) * 4;
      const o = (y * w + x) * 4;
      out[o] = small[so];
      out[o + 1] = small[so + 1];
      out[o + 2] = small[so + 2];
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// Deterministic additive grey noise. `amount` is the max +/- perturbation
// applied to each pixel's luminance (uniform in [-amount, amount]),
// independently per pixel, clamped to [0, 255]. `seed` drives a small
// xorshift-style PRNG (mulberry32) so the SAME seed always reproduces the
// SAME noise field -- required for the measurement to be repeatable across
// runs.
export function noise(img, amount, seed = 1) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data);
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < w * h; i++) {
    const n = (rnd() * 2 - 1) * amount;
    const o = i * 4;
    const v = Math.max(0, Math.min(255, data[o] + n));
    out[o] = out[o + 1] = out[o + 2] = v;
    out[o + 3] = 255;
  }
  return { width: w, height: h, data: out };
}
