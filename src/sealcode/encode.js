import { N, GRID, CARRIERS } from './baseline.js';
import { encode as payloadToBits, bitsToPayload } from './payload.js';

// EMB seal code — encoder.
//
// The mark IS the logo, pixelated. Data is carried by clearing tiles: a carrier
// tile keeps its ink for a 1 and is cleared to white for a 0. Nothing is ever
// added, so the silhouette, the tree and the bands are unchanged on every
// document; only interior fill varies.

export const SIZE = N;

/** Baseline tile states as a mutable N x N array of 0/1. */
export function baselineTiles() {
  return GRID.map((row) => Array.from(row, (ch) => (ch === '1' ? 1 : 0)));
}

/**
 * @param {string} payload e.g. 'CVR|R1-2026-010734|1|PP64-QXA6'
 * @returns {number[][]} N x N tile states (1 = inked)
 */
export function tilesFor(payload) {
  const bits = payloadToBits(payload);
  if (bits.length > CARRIERS.length) {
    throw new Error(`payload needs ${bits.length} carriers, only ${CARRIERS.length} available`);
  }
  const tiles = baselineTiles();
  for (let i = 0; i < CARRIERS.length; i++) {
    const [r, c] = CARRIERS[i];
    // Carriers beyond the payload stay inked, so unused capacity is invisible.
    tiles[r][c] = i < bits.length ? bits[i] : 1;
  }
  return tiles;
}

/** Read tiles back to a payload (the inverse of tilesFor). */
export function payloadFromTiles(tiles) {
  const bits = new Uint8Array(CARRIERS.length);
  for (let i = 0; i < CARRIERS.length; i++) {
    const [r, c] = CARRIERS[i];
    bits[i] = tiles[r][c] ? 1 : 0;
  }
  return bitsToPayload(bits);
}

/**
 * Printable SVG. `px` is the rendered size; at 22 mm this is the mark that goes
 * on the page.
 */
export function renderSvg(payload, { px = 512 } = {}) {
  const tiles = tilesFor(payload);
  const s = px / N;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}">`;
  out += `<rect width="${px}" height="${px}" fill="#fff"/>`;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!tiles[r][c]) continue;
      // +0.35 overlap so neighbouring tiles abut with no hairline seam
      out += `<rect x="${(c * s).toFixed(2)}" y="${(r * s).toFixed(2)}" width="${(s + 0.35).toFixed(2)}" height="${(s + 0.35).toFixed(2)}" fill="#111"/>`;
    }
  }
  return out + '</svg>';
}

/** Pixel rasterizer, so the decoder can be exercised without a browser. */
export function rasterize(payload, { px = 512, quiet = 0.08 } = {}) {
  const tiles = tilesFor(payload);
  const pad = Math.round(px * quiet); // quiet zone, as any code needs
  const W = px + pad * 2;
  const s = px / N;
  const data = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!tiles[r][c]) continue;
      const x0 = Math.round(pad + c * s);
      const y0 = Math.round(pad + r * s);
      const x1 = Math.round(pad + (c + 1) * s);
      const y1 = Math.round(pad + (r + 1) * s);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * W + x) * 4;
          data[o] = data[o + 1] = data[o + 2] = 0;
          data[o + 3] = 255;
        }
      }
    }
  }
  return { width: W, height: W, data };
}
