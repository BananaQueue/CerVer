import bwipjs from 'bwip-js';

// Render a Data Matrix to a PNG buffer (for embedding in the sealed PDF).
export async function dataMatrixPng(text, { scale = 4 } = {}) {
  return bwipjs.toBuffer({
    bcid: 'datamatrix',
    text: String(text),
    scale,
    padding: 2,
    backgroundcolor: 'FFFFFF',
    color: '000000', // black — maximum contrast for reliable scanning
  });
}
