// Reed-Solomon codec over GF(2^8), matching the field built in gf256.js
// (primitive polynomial 0x11d, generator alpha = 2).
//
// rsEncode is a systematic RS encoder: the output is the data bytes
// unchanged, followed by nsym parity bytes computed as the remainder of
// dividing data(x) * x^nsym by the generator polynomial.
//
// rsDecode implements the standard syndrome decoding pipeline:
//   1. Syndromes: evaluate the received polynomial at alpha^0..alpha^(nsym-1).
//      All zero means no errors.
//   2. Berlekamp-Massey: find the shortest LFSR (error locator polynomial)
//      that generates the syndrome sequence.
//   3. Chien search: find the roots of the error locator polynomial by
//      brute-force evaluation, which give the error positions.
//   4. Forney algorithm: compute the error-value (magnitude) polynomial and
//      evaluate it at each error position to get the magnitudes.
//   5. Apply corrections, then re-verify that syndromes are all zero before
//      trusting the result.

import { EXP, mul, inv } from './gf256.js';

function polyMul(a, b) {
  const r = new Uint8Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j++) r[i + j] ^= mul(a[i], b[j]);
  }
  return r;
}

// Evaluate polynomial p (coefficients in descending-power order, p[0] is the
// highest-degree coefficient) at x, via Horner's method.
function polyEval(p, x) {
  let y = 0;
  for (let i = 0; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

function generator(nsym) {
  let g = Uint8Array.from([1]);
  for (let i = 0; i < nsym; i++) g = polyMul(g, Uint8Array.from([1, EXP[i]]));
  return g;
}

export function rsEncode(data, nsym) {
  const gen = generator(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
    }
  }
  out.set(data, 0); // restore data region (systematic); parity is untouched
  return out;
}

// synd[i] = code(alpha^i), for i = 0..nsym-1.
function syndromes(code, nsym) {
  const s = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) s[i] = polyEval(code, EXP[i]);
  return s;
}

// Berlekamp-Massey over GF(256). Returns the error locator polynomial
// (descending-power order, constant term last) of minimal degree that
// generates the given syndrome sequence.
function berlekampMassey(synd, nsym) {
  let errLoc = Uint8Array.from([1]);
  let oldLoc = Uint8Array.from([1]);
  for (let i = 0; i < nsym; i++) {
    oldLoc = Uint8Array.from([...oldLoc, 0]);

    // delta = discrepancy between the current LFSR's prediction and synd[i]
    let delta = synd[i];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= mul(errLoc[errLoc.length - 1 - j], synd[i - j]);
    }
    if (delta === 0) continue;

    if (oldLoc.length > errLoc.length) {
      const newLoc = oldLoc.map((c) => mul(c, delta));
      oldLoc = errLoc.map((c) => mul(c, inv(delta)));
      errLoc = newLoc;
    }

    const scaled = oldLoc.map((c) => mul(c, delta));
    const res = new Uint8Array(Math.max(errLoc.length, scaled.length));
    res.set(errLoc, res.length - errLoc.length);
    for (let k = 0; k < scaled.length; k++) res[res.length - scaled.length + k] ^= scaled[k];
    errLoc = res;
  }
  return errLoc;
}

export function rsDecode(code, nsym) {
  code = Uint8Array.from(code); // never mutate the caller's array
  const dataLen = code.length - nsym;

  const synd = syndromes(code, nsym);
  if (synd.every((v) => v === 0)) return code.slice(0, dataLen);

  const errLoc = berlekampMassey(synd, nsym);
  const errCount = errLoc.length - 1;
  if (errCount <= 0 || errCount * 2 > nsym) return null;

  // Chien search: errLoc's roots are alpha^(-position). Try every position
  // in the codeword and keep the ones for which errLoc(alpha^(-i)) == 0.
  const positions = [];
  for (let i = 0; i < code.length; i++) {
    const x = EXP[(255 - (i % 255)) % 255];
    if (polyEval(errLoc, x) === 0) positions.push(code.length - 1 - i);
  }
  if (positions.length !== errCount) return null; // more roots than the degree predicts: uncorrectable

  // Error evaluator polynomial. Our syndromes start at alpha^0 (synd[0] is
  // S_0), but the Forney derivation needs the "shifted" syndrome series
  // T(x) = S_1 + S_2*x + S_3*x^2 + ... (S_0 dropped) for the key equation
  // T(x) * errLoc(x) = omega(x) (mod x^(nsym-1)) to hold. Build T(x) in
  // descending-power order (as polyMul/polyEval expect) and take the
  // low-order terms of the product, which are omega's true coefficients
  // since deg(omega) < errCount <= nsym-1.
  const shifted = synd.slice(1);
  const revShifted = Uint8Array.from(shifted).reverse();
  const product = polyMul(revShifted, errLoc);
  const errEval = product.slice(product.length - (nsym - 1));

  // Formal derivative of errLoc, kept at full length (descending-power
  // order) so each surviving coefficient stays at its true power: in
  // GF(2^k) the derivative kills every even-power term (2*c = 0), so only
  // odd-power coefficients of errLoc survive, shifted down by one power.
  const derivLen = errLoc.length - 1;
  const errLocDeriv = new Uint8Array(derivLen);
  for (let m = 0; m < derivLen; m++) {
    const power = derivLen - 1 - m; // power of this term in the derivative
    if (power % 2 === 0) errLocDeriv[m] = errLoc[m];
  }

  for (const pos of positions) {
    const p = code.length - 1 - pos; // power/position of this error
    const xiInv = EXP[(255 - (p % 255)) % 255]; // X_l^-1 = alpha^-p

    const num = polyEval(errEval, xiInv);
    const den = polyEval(errLocDeriv, xiInv);
    if (den === 0) return null;

    // Forney formula: magnitude_l = omega(X_l^-1) / errLoc'(X_l^-1).
    const magnitude = mul(num, inv(den));
    code[pos] ^= magnitude;
  }

  if (!syndromes(code, nsym).every((v) => v === 0)) return null;
  return code.slice(0, dataLen);
}
