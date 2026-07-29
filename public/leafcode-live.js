// LeafCode live demo — renders a leaf from a page seal and decodes it back in
// the browser. Everything here runs client-side against the same modules the
// Node tests use, served as ESM from /leafcode/.

import { encode } from '/leafcode/codec.js';
import { renderSvg } from '/leafcode/render.js';
import { decode } from '/leafcode/decode.js';

const $ = (id) => document.getElementById(id);
const resultEl = $('result');
const stage = $('lcStage');
const art = $('lcArt');
const hint = $('lcHint');

let currentPayload = '';
let currentSvg = '';

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function card(ink, stamp, sub, eyebrow, id, msg) {
  resultEl.hidden = false;
  resultEl.innerHTML = `
    <div class="doc" style="--state:${ink}">
      <div class="stamp">${esc(stamp)}<small>${esc(sub)}</small></div>
      <p class="doc-eyebrow">${esc(eyebrow)}</p>
      <p class="doc-id">${esc(id)}</p>
      <p class="doc-msg">${esc(msg)}</p>
    </div>`;
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function normSeal(s) {
  const t = String(s || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  return t.length === 8 ? t.slice(0, 4) + '-' + t.slice(4) : t;
}

// ---- Generate ----
$('genForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const doc = $('lcDoc').value.trim().toUpperCase().replace(/^EMB(?=R1-)/, '');
  const k = ($('lcK').value.match(/\d+/) || [])[0] || '';
  const seal = normSeal($('lcSeal').value);
  const payload = `CVR|${doc}|${k}|${seal}`;
  try {
    currentSvg = renderSvg(encode(payload), { px: 1000 });
    currentPayload = payload;
    art.innerHTML = currentSvg.replace('<svg', '<svg class="lc-svg"');
    $('lcPayload').textContent = payload;
    $('lcDownload').href = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(currentSvg);
    stage.hidden = false;
    resultEl.hidden = true;
    stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    card('var(--stamp-slate)', 'Bad input', 'Rejected', 'Could not encode', payload, String(err.message || err));
  }
});

// Rasterize an SVG string to ImageData at a given size.
async function svgToImageData(svg, px = 1000) {
  const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  const img = new Image();
  img.src = url;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = px;
  cv.height = px;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.drawImage(img, 0, 0, px, px);
  return ctx.getImageData(0, 0, px, px);
}

function report(got) {
  if (got && got === currentPayload) {
    card('var(--stamp-green)', 'Decoded', 'Exact match', 'LeafCode read', got, 'Recovered exactly the payload that was encoded.');
  } else if (got) {
    card('var(--stamp-green)', 'Decoded', 'Read', 'LeafCode read', got, 'Payload recovered from the image.');
  } else {
    card('var(--stamp-red)', 'No read', 'Undecodable', 'Nothing found', '—', 'No LeafCode could be decoded from that image. Get closer, flatten the angle, and make sure the whole leaf is in frame under even light.');
  }
}

// ---- Self-test: decode the leaf we just drew ----
$('lcSelfTest').addEventListener('click', async () => {
  card('var(--stamp-slate)', '…', 'Working', 'Decoding', currentPayload, 'Rasterizing the SVG and running the decoder…');
  try {
    report(decode(await svgToImageData(currentSvg, 1000)));
  } catch (err) {
    card('var(--stamp-red)', 'Error', 'Failed', 'Decoder error', '—', String(err.message || err));
  }
});

// ---- Decode an uploaded image ----
$('lcFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  card('var(--stamp-slate)', '…', 'Working', 'Decoding', file.name, 'Reading the image…');
  try {
    const bmp = await createImageBitmap(file);
    const px = Math.min(1400, Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = px;
    cv.height = px;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, px, px);
    const s = Math.min(px / bmp.width, px / bmp.height);
    const w = bmp.width * s;
    const h = bmp.height * s;
    ctx.drawImage(bmp, (px - w) / 2, (px - h) / 2, w, h);
    report(decode(ctx.getImageData(0, 0, px, px)));
  } catch (err) {
    card('var(--stamp-red)', 'Error', 'Failed', 'Could not read image', '—', String(err.message || err));
  }
});

// ---- Camera ----
const video = $('lcVideo');
const viewport = $('lcViewport');
const camBtn = $('lcCam');
let stream = null;
let loopId = null;

async function startCam() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    hint.textContent = 'The camera needs a secure page — use http://localhost or the https://…:3443 address.';
    return;
  }
  hint.textContent = 'Requesting camera…';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream;
    await video.play();
    viewport.classList.add('live');
    camBtn.textContent = 'Stop camera';
    hint.textContent = 'Fill the frame with the leaf and hold steady.';
    scanLoop();
  } catch (err) {
    hint.textContent = 'Couldn’t open the camera: ' + (err.name || err.message || 'unknown') + '.';
  }
}

function stopCam() {
  if (loopId) cancelAnimationFrame(loopId);
  loopId = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  viewport.classList.remove('live');
  camBtn.textContent = 'Start camera';
  hint.textContent = 'Fill the frame with the leaf and hold steady.';
}

function scanLoop() {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let busy = false;
  const tick = () => {
    if (!stream) return;
    if (!busy && video.videoWidth) {
      busy = true;
      const px = 1000;
      cv.width = px;
      cv.height = px;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, px, px);
      const side = Math.min(video.videoWidth, video.videoHeight);
      ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, px, px);
      try {
        const got = decode(ctx.getImageData(0, 0, px, px));
        if (got) {
          stopCam();
          report(got);
          return;
        }
      } catch { /* keep scanning */ }
      busy = false;
    }
    loopId = requestAnimationFrame(tick);
  };
  tick();
}

camBtn.addEventListener('click', () => (stream ? stopCam() : startCam()));
