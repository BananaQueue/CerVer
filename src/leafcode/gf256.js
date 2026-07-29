// GF(2^8) with primitive polynomial 0x11d, generator 2.
export const EXP = new Uint8Array(512);
export const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

export function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}
export function inv(a) {
  if (a === 0) throw new Error('inv(0)');
  return EXP[255 - LOG[a]];
}
