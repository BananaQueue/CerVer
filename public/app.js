// CerVer page-verification client.
//
// Document-level verification is deliberately absent: the QR already printed on
// EMB documents does that job, the phone's own camera reads it, and it lands on
// the office's own iis.emb.gov.ph page. Duplicating it here would only add a
// second answer to a question already answered. What this app covers is the part
// that QR cannot reach — whether the PAGE in your hand belongs to the document,
// and what the authoritative page actually says.

const resultEl = document.getElementById('result');

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- The mark, as furniture ----
//
// The artwork is the aiming target in the idle viewport and the ornament beside
// each verdict, drawn by the same encoder that stamps the paper. It is what the
// person is hunting for on the sheet, so showing it costs nothing and saves
// explaining.
let renderSvg = null;
const markSvg = (payload, px) => {
  try {
    return renderSvg ? renderSvg(payload, { px }) : '';
  } catch {
    return '';
  }
};
(async () => {
  try {
    ({ renderSvg } = await import('/sealcode/encode.js'));
    const sample = 'CVR|R1-2026-010734|1|E67R-CCT7';
    document.getElementById('crest').innerHTML = markSvg(sample, 60);
    document.getElementById('target').innerHTML = markSvg(sample, 300);
  } catch (e) {
    console.warn('seal artwork unavailable', e);
  }
})();

// ---- Explanation on demand ----
//
// Every nuance here is worth stating and none is worth a paragraph at a counter,
// so each one is a line with a button that opens the rest.
function wireInfo(root = document) {
  for (const b of root.querySelectorAll('.info')) {
    if (b.dataset.wired) continue;
    b.dataset.wired = '1';
    b.addEventListener('click', () => {
      const open = b.getAttribute('aria-expanded') === 'true';
      b.setAttribute('aria-expanded', String(!open));
      document.getElementById(b.getAttribute('aria-controls'))?.classList.toggle('open', !open);
    });
  }
}
wireInfo();

// ---- The one button at the bottom of the screen ----
//
// A counter tool is held in one hand, so the primary action lives in the thumb
// zone and changes with the situation rather than multiplying into a row of
// buttons the thumb cannot reach.
const actionBtn = document.getElementById('scanToggle2');
const scope = document.getElementById('scope');
const lookfor = document.getElementById('lookfor');
const fold = document.getElementById('fold');
const scanArea = document.getElementById('scanArea');

// `show` covers the explaining; the camera is a separate switch, because it
// stays up while scanning but gives way once there is a verdict to read.
const orientation = (show, camera = true) => {
  for (const el of [scope, lookfor, fold]) if (el) el.hidden = !show;
  if (scanArea) scanArea.hidden = !camera;
  if (!show) document.getElementById('scopeMore')?.classList.remove('open');
};

function clearResult() {
  resultEl.hidden = true;
  resultEl.innerHTML = '';
}

// ---- Pages on record ----
//
// A valid seal says the sheet belongs to the document. It says nothing about
// what the sheet should CONTAIN — that cannot be checked from paper, because
// the content half of the seal is a hash and paper cannot be hashed. So the
// answer is to put the document's real pages in front of the reader: how many
// there should be, and the exact footer stamped on each. A page that was
// inserted has no matching line, and a short document is visibly short.
async function showPages(iisNo, highlightK) {
  let data;
  try {
    data = await (await fetch('/api/pages/' + encodeURIComponent(iisNo))).json();
  } catch {
    return;
  }
  if (!data.pages || !data.pages.length) return;

  // The control number is already on the verdict above; repeating it on every
  // row is noise. What changes per page is the seal, so that is what shows.
  const rows = data.pages
    .map(
      (p) => `
      <li class="${p.k === highlightK ? 'here' : ''}">
        <span class="pk">p${p.k}/${p.n}</span>
        <span class="sealtxt">K${esc(p.kid)} · <b>${esc(p.seal)}</b></span>
        ${p.hasImage
          ? `<button class="cmp" type="button" data-doc="${esc(iisNo)}" data-k="${p.k}">Compare</button>`
          : '<button class="cmp" type="button" disabled>—</button>'}
      </li>`
    )
    .join('');

  const box = document.createElement('section');
  box.className = 'rec';
  box.innerHTML = `
    <div class="line">
      <h2>Pages on record — ${data.pages.length} of ${data.total}</h2>
      <button class="info" type="button" aria-expanded="false" aria-controls="pagesMore"
              aria-label="More about the page list">i</button>
    </div>
    <p class="more" id="pagesMore">
      The footer on your sheet reads<br>
      <code>${esc(data.pages[0].footer)}</code><br>
      — the part after K${esc(data.pages[0].kid)} changes per page. A page not
      listed here is not part of this document, and a document that should have
      ${data.total} pages is short if you hold fewer.
    </p>
    <ul class="pages">${rows}</ul>`;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button.cmp');
    if (b && !b.disabled) showReference(b.dataset.doc, Number(b.dataset.k));
  });
  resultEl.appendChild(box);
  wireInfo(box);
}

// ---- The cross-reference view ----
//
// The authoritative page, rendered here rather than handed over as a PDF
// download. On a phone a downloaded PDF leaves the app and comes back zoomed to
// fit, which is useless for comparing wording against a sheet on the desk; this
// keeps it beside the verdict and under the reader's own zoom.
const reference = (() => {
  const box = document.getElementById('reference');
  const stage = document.getElementById('refStage');
  const statusEl = document.getElementById('refStatus');
  const titleEl = document.getElementById('refTitle');
  const zoomEl = document.getElementById('refZoom');
  const pdfLink = document.getElementById('refPdf');
  let pdfjs = null;
  let page = null;
  let scale = 1;

  async function lib() {
    if (!pdfjs) {
      pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    }
    return pdfjs;
  }

  async function draw() {
    if (!page) return;
    // Render at the device's real pixel density, so text stays sharp when the
    // reader zooms in to compare a figure or a signature.
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const width = stage.clientWidth || 320;
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: ((width / base.width) * scale) * dpr });
    const cv = document.createElement('canvas');
    cv.width = vp.width;
    cv.height = vp.height;
    cv.style.width = `${vp.width / dpr}px`;
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    stage.innerHTML = '';
    stage.appendChild(cv);
    zoomEl.textContent = `${Math.round(scale * 100)}%`;
  }

  async function show(iisNo, k) {
    box.hidden = false;
    stage.innerHTML = '';
    stage.appendChild(statusEl);
    statusEl.textContent = 'Loading the authoritative page…';
    titleEl.textContent = `Authoritative page ${k} — ${iisNo}`;
    const url = `/api/page-image?doc=${encodeURIComponent(iisNo)}&k=${k}`;
    pdfLink.href = url;
    scale = 1;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        statusEl.textContent = j.error || 'No authoritative copy is on file for this page.';
        return;
      }
      const buf = await res.arrayBuffer();
      const doc = await (await lib()).getDocument({
        data: new Uint8Array(buf),
        // Sealed pages use the standard PDF fonts, which are not embedded in the
        // file. Without somewhere to fetch them, rendering stalls with no error.
        standardFontDataUrl: '/vendor/pdfjs-fonts/',
      }).promise;
      page = await doc.getPage(1);
      await draw();
    } catch (e) {
      statusEl.textContent = 'Could not render the page — ' + e.message;
      stage.innerHTML = '';
      stage.appendChild(statusEl);
    }
  }

  document.getElementById('refClose').addEventListener('click', () => {
    box.hidden = true;
    page = null;
  });
  document.getElementById('refZoomIn').addEventListener('click', () => {
    scale = Math.min(4, scale * 1.4);
    draw();
  });
  document.getElementById('refZoomOut').addEventListener('click', () => {
    scale = Math.max(0.5, scale / 1.4);
    draw();
  });

  return { show, hide: () => { box.hidden = true; page = null; } };
})();

function showReference(iisNo, k) {
  reference.show(iisNo, k);
}

// ---- Camera scanning ----
function showCameraError(hintEl, e) {
  // html5-qrcode sometimes rejects with a plain string, not a DOMException.
  const text =
    typeof e === 'string'
      ? e
      : (e && (e.name || e.message)) || (e && e.toString && e.toString()) || '';
  console.error('CerVer camera:', e);
  const t = String(text).toLowerCase();
  let msg;
  if (/notallowed|permission|denied|dismiss/.test(t)) {
    msg = 'Camera permission is blocked. Tap the camera / lock icon in the address bar → Allow → reload.';
  } else if (/notfound|no camera|not found|devicesnotfound|requested device not/.test(t)) {
    msg = 'No camera found on this device. Use manual entry below.';
  } else if (/notreadable|in use|could not start|starting video|trackstart|abort/.test(t)) {
    msg = 'The camera is being used by another app. Close it, then try again.';
  } else if (/secure|https|insecure/.test(t)) {
    msg = 'The camera needs HTTPS — open the https://…:3443 address (accept the warning once).';
  } else if (/not supported|unsupported|getusermedia/.test(t)) {
    msg = 'This browser can’t open the camera in-page. Try Chrome, or use manual entry.';
  } else {
    msg = 'Couldn’t open the camera: ' + (text || 'no detail') + '. Use manual entry below.';
  }
  hintEl.textContent = msg;
}

// ---- One-page scanner: reads the EMB seal code AND the Data Matrix ----
//
// This one runs its own capture loop rather than using html5-qrcode, because
// each frame has to be offered to two decoders:
//   1. our seal-code decoder, imported from /sealcode/ — the exact module the
//      test suite exercises, so there is no second implementation to drift
//   2. the Data Matrix — the browser's native BarcodeDetector where it exists,
//      otherwise html5-qrcode's file decoder, which is slow enough that it only
//      gets a frame twice a second
// Whichever reads first wins.
const pageScanner = (() => {
  const viewport = document.getElementById('viewport2');
  const toggle = document.getElementById('scanToggle2');
  const hint = document.getElementById('scanHint2');
  const video = document.getElementById('pageVideo');
  const diag = document.getElementById('pageDiag');
  const metrics = document.getElementById('diagMetrics');
  const say = document.getElementById('diagSay');
  const aim = document.getElementById('aim');
  const saveBtn = document.getElementById('saveFrame');
  let stream = null;
  let raf = null;
  let sealInspect = null;
  let lastFrame = null; // most recent capture, for "save this frame"
  let lastInfo = null;

  async function ensureDecoders() {
    if (!sealInspect) {
      try {
        ({ inspect: sealInspect } = await import('/sealcode/decode.js'));
      } catch (e) {
        console.error('seal-code decoder failed to load', e);
        say.textContent = 'Decoder failed to load';
      }
    }
  }

  async function start() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      hint.textContent =
        'The camera needs a secure page. On a phone open the https://…:3443 address; on this PC use http://localhost.';
      return;
    }
    await ensureDecoders();
    hint.textContent = 'Requesting camera…';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      viewport.classList.add('live');
      toggle.textContent = 'Stop camera';
      hint.textContent = '';
      diag.hidden = false;
      saveBtn.hidden = false;
      orientation(false); // the camera is up; the explaining is done
      clearResult();
      loop();
    } catch (err) {
      showCameraError(hint, err);
      stop();
    }
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    viewport.classList.remove('live');
    diag.hidden = true;
    saveBtn.hidden = true;
    toggle.textContent = 'Scan the seal';
    // A result of its own will re-hide these; on a plain stop they come back.
    if (resultEl.hidden) orientation(true);
  }

  // Turn the decoder's diagnostics into something aimable.
  //
  // The two ways a scan fails look identical to the user — nothing happens — but
  // they need opposite corrections. Too few pixels per tile means move closer;
  // a good pitch with a poor fixed-tile score means the mark is found but the
  // reading is wrong (blur, glare, or something else dark dragged into its
  // bounding box), so the fix is to isolate the seal, not to approach it.
  const MIN_PITCH = 3; // px per tile below which detail is simply not there
  function report(info) {
    if (!info) return;
    const pitch = info.pitch || 0;
    const score = info.score || 0;
    let cls, msg;
    if (score >= 0.72) {
      cls = 'good'; msg = 'Reading…';
    } else if (score >= 0.45) {
      cls = 'warn'; msg = 'Steady, more light';
    } else if (pitch < MIN_PITCH) {
      cls = 'bad'; msg = 'Move closer';
    } else {
      cls = 'bad'; msg = 'No seal in view';
    }
    // One line. The numbers are for whoever is debugging it; the phrase on the
    // right is for whoever is holding the phone.
    diag.className = 'readout is-' + cls;
    metrics.textContent =
      `${pitch.toFixed(1)} px/tile · ${(score * 100).toFixed(0)}% match · ${info.deg || 0}°`;
    say.textContent = msg;
    aim.textContent = cls === 'good' ? 'Hold steady' : 'Fill the frame with the seal';
  }

  // Ship a failing frame to the server so the decoder can be worked on against
  // the real image rather than a guess about what the camera saw.
  saveBtn?.addEventListener('click', async () => {
    if (!lastFrame) { say.textContent = 'No frame yet'; return; }
    saveBtn.disabled = true;
    const prev = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    try {
      const dataUrl = lastFrame.toDataURL('image/png');
      const r = await fetch('/api/frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, info: lastInfo, ua: navigator.userAgent }),
      });
      const j = await r.json();
      saveBtn.textContent = r.ok ? `Saved ${j.file}` : `Failed: ${j.error || r.status}`;
    } catch (e) {
      saveBtn.textContent = 'Failed: ' + e.message;
    }
    setTimeout(() => { saveBtn.textContent = prev; saveBtn.disabled = false; }, 2500);
  });

  function loop() {
    const cv = document.createElement('canvas');
    const cx = cv.getContext('2d', { willReadFrequently: true });
    let busy = false;
    const tick = async () => {
      if (!stream) return;
      if (!busy && video.videoWidth) {
        busy = true;
        try {
          // Centre square crop, so the seal fills as much of the frame as possible.
          const side = Math.min(video.videoWidth, video.videoHeight);
          const px = Math.min(700, side);
          cv.width = px;
          cv.height = px;
          cx.fillStyle = '#fff';
          cx.fillRect(0, 0, px, px);
          cx.drawImage(
            video,
            (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side,
            0, 0, px, px
          );

          if (sealInspect) {
            const info = sealInspect(cx.getImageData(0, 0, px, px));
            lastFrame = cv; // live canvas — encoded only if the user asks to save
            lastInfo = info;
            report(info);
            if (info.payload) { stop(); handlePagePayload(info.payload); return; }
          }
        } catch {
          /* keep scanning */
        }
        busy = false;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  // One button, three jobs — see the note on the action bar above.
  toggle.addEventListener('click', () => {
    if (stream) return stop();
    if (!resultEl.hidden) {
      // showing a verdict: clear it and go back to a ready camera
      clearResult();
      reference.hide();
      orientation(true);
      toggle.textContent = 'Scan the seal';
      return;
    }
    start();
  });
  return { start, stop, isActive: () => !!stream };
})();

// ---- Mode switching ----
const PAGE_STATES = {
  page_verified: { ink: 'var(--ok)', stamp: 'Page ok', sub: 'Authentic seal', eyebrow: 'Authentic page seal', msg: 'Genuine for its position in the document.' },
  invalid_seal: { ink: 'var(--bad)', stamp: 'Bad seal', sub: 'Not authentic', eyebrow: 'Invalid seal', msg: 'Not a valid EMB seal for this page. Treat the copy with caution.' },
  not_sealed: { ink: 'var(--warn)', stamp: 'Not sealed', sub: 'No record', eyebrow: 'No sealed page found', msg: 'Nothing on record matches. It may be unsealed, or from another document.' },
  page_count_mismatch: { ink: 'var(--warn)', stamp: 'Count off', sub: 'Page count', eyebrow: 'Page-count mismatch', msg: 'This claims a different page count than the registered document.' },
  invalid_code: { ink: 'var(--slate)', stamp: 'Unreadable', sub: 'Bad format', eyebrow: 'Couldn’t read that', msg: 'That isn’t a page seal line. Check for typos.' },
};
const PAGE_COLORS = { verified: 'var(--ok)', content_altered: 'var(--bad)', not_sealed: 'var(--warn)' };
const PAGE_LABELS = { verified: 'verified', content_altered: 'altered', not_sealed: 'unsealed' };

const panels = document.querySelectorAll('.mode-panel');
document.querySelector('.modes').addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('is-active', b === btn);
    b.setAttribute('aria-selected', String(b === btn));
  });
  const mode = btn.dataset.mode;
  panels.forEach((p) => (p.hidden = p.id !== 'mode-' + mode));
  pageScanner.stop();
  reference.hide();
  clearResult();
  // The camera and its orientation copy belong to the page mode only.
  orientation(mode === 'page');
  document.querySelector('.actionbar').hidden = mode !== 'page';
  actionBtn.textContent = 'Scan the seal';
});

// ---- Page-seal verification ----
// Pull control number + page + seal out of a pasted footer line (only when it
// clearly IS a footer, so a bare control number typed on its own isn't mangled).
function parseFooterLoose(s) {
  const raw = String(s || '');
  if (!/·|EMB\b|p\s*\d+\s*\//i.test(raw)) return null;
  const up = raw.toUpperCase();
  const iis = (up.match(/R1-(?:19|20)\d\d-\d{3,}/) || [])[0];
  const seals = [...up.matchAll(/[A-Z2-7]{4}-[A-Z2-7]{4}/g)].map((m) => m[0]);
  const kM = up.match(/P\s*(\d+)\s*\//);
  const seal = seals.length ? seals[seals.length - 1] : null;
  return iis && seal ? { iisNo: iis, k: kM ? kM[1] : '', seal } : null;
}
function canonDoc(s) {
  return String(s || '').trim().toUpperCase().replace(/^EMB(?=R1-)/, '');
}
function normSeal(s) {
  const t = String(s || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  return t.length === 8 ? t.slice(0, 4) + '-' + t.slice(4) : t;
}

// Decode a scanned Data Matrix payload (CVR|iisNo|k|seal).
function parsePayloadClient(text) {
  const m = String(text || '').match(/^CVR\|([^|]+)\|(\d+)\|([0-9A-Za-z-]+)/i);
  return m ? { iisNo: m[1].toUpperCase(), k: m[2], seal: m[3].toUpperCase() } : null;
}

// Camera decode → fill the fields and verify.
function handlePagePayload(text) {
  const p = parsePayloadClient(text) || parseFooterLoose(text);
  if (p && p.iisNo && p.k && p.seal) {
    document.getElementById('pgDoc').value = p.iisNo;
    document.getElementById('pgK').value = p.k;
    document.getElementById('pgSeal').value = normSeal(p.seal);
    submitPageVerify();
  } else {
    renderPageResult({ status: 'invalid_code' });
  }
}

async function submitPageVerify() {
  const docEl = document.getElementById('pgDoc');
  const kEl = document.getElementById('pgK');
  const sealEl = document.getElementById('pgSeal');

  const pasted = parseFooterLoose(docEl.value) || parseFooterLoose(sealEl.value);
  let doc, k, seal;
  if (pasted) {
    doc = pasted.iisNo;
    k = pasted.k || (kEl.value.match(/\d+/) || [])[0] || '';
    seal = pasted.seal;
    docEl.value = doc;
    kEl.value = k;
    sealEl.value = seal;
  } else {
    doc = canonDoc(docEl.value);
    k = (kEl.value.match(/\d+/) || [])[0] || '';
    seal = normSeal(sealEl.value);
  }

  if (!doc || !k || !seal) {
    renderPageResult({ status: 'invalid_code' });
    return;
  }

  const staff = document.getElementById('pageStaff').checked ? '&staff=1' : '';
  renderPageResult({ status: 'loading' });
  try {
    const res = await fetch(
      `/api/verify-page?doc=${encodeURIComponent(doc)}&k=${encodeURIComponent(k)}&seal=${encodeURIComponent(seal)}` +
        staff
    );
    const data = await res.json();
    data._seal = seal;
    renderPageResult(data);
  } catch {
    renderPageResult({ status: 'error' });
  }
}

document.getElementById('pageForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submitPageVerify();
});

// Look the page up WITHOUT a seal claim. Someone holding a sheet whose seal will
// not scan and whose footer is smudged can still get to the authoritative page
// and compare it by eye — which is the check that catches altered wording
// anyway. It is deliberately not dressed up as a verdict: nothing has been
// verified, the page is simply shown.
document.getElementById('refBtn').addEventListener('click', async () => {
  const doc = canonDoc(document.getElementById('pgDoc').value);
  const k = (document.getElementById('pgK').value.match(/\d+/) || [])[0] || '';
  if (!doc || !k) {
    renderPageResult({ status: 'need_doc_and_page' });
    return;
  }
  showReference(doc, Number(k));
  showPagesStandalone(doc, Number(k));
});

// The pages list on its own, for the reference-only path where there is no
// verdict card to hang it under.
async function showPagesStandalone(iisNo, k) {
  resultEl.hidden = false;
  resultEl.innerHTML = `
    <div class="verdict" style="--state:var(--slate)">
      <p class="eyebrow">Reference only — nothing verified</p>
      <p class="docid">${esc(iisNo)}</p>
      <p class="msg">Page ${esc(k)} as it was sealed, for comparison.</p>
    </div>`;
  orientation(false, false);
  actionBtn.textContent = 'Check another page';
  showPages(iisNo, k);
}

function renderPageResult(data) {
  const brief = (state, eyebrow, msg) => {
    resultEl.hidden = false;
    resultEl.innerHTML =
      `<div class="verdict" style="--state:${state}">` +
      `<p class="eyebrow">${esc(eyebrow)}</p><p class="msg">${esc(msg)}</p></div>`;
  };
  if (data.status === 'loading') return brief('var(--slate)', 'Checking', 'Reading the registry…');
  if (data.status === 'error')
    return brief('var(--bad)', 'No connection', 'Couldn’t reach the service. Check the connection and try again.');
  if (data.status === 'need_doc_and_page')
    return brief('var(--slate)', 'Need a bit more', 'Type the control number and the page number.');

  const s = PAGE_STATES[data.status] || PAGE_STATES.invalid_code;
  const where = data.k && data.n ? `Page ${data.k} of ${data.n}` : '';
  const payload =
    data.iisNo && data.k && data._seal ? `CVR|${data.iisNo}|${data.k}|${data._seal}` : null;

  // The mark beside its own line. Holding these two up against the sheet is the
  // physical act the whole app exists to support, so they belong together.
  const match = payload
    ? `<div class="matchrow">
         <span class="mk" aria-hidden="true">${markSvg(payload, 120)}</span>
         <code>EMB · ${esc(data.iisNo)} · p${esc(data.k)}/${esc(data.n)} · K${esc(data.kid || '1')} · <b>${esc(data._seal)}</b></code>
       </div>`
    : '';

  const verified = data.status === 'page_verified';
  resultEl.hidden = false;
  resultEl.innerHTML = `
    <div class="verdict" style="--state:${s.ink}">
      <div class="stamp">${esc(s.stamp)}<small>${esc(s.sub)}</small></div>
      <p class="eyebrow">${esc(s.eyebrow)}</p>
      <p class="docid">${esc(data.iisNo || '—')}</p>
      ${where ? `<p class="pos">${esc(where)}</p>` : ''}
      ${match}
      ${verified
        ? `<div class="line" style="margin-bottom:0.8rem">
             <p class="note">Proves position, not wording.</p>
             <button class="info" type="button" aria-expanded="false" aria-controls="verdictMore"
                     aria-label="More about what the seal proves">i</button>
           </div>
           <p class="more" id="verdictMore">
             The seal is genuine for this position in the document, so the sheet is
             not from another document and is not out of order. It cannot confirm
             the words printed on it — paper cannot be hashed. Compare with the real
             page for that.
           </p>`
        : `<p class="msg">${esc(s.msg)}</p>`}
      ${data.iisNo && data.k
        ? '<button class="btn btn-primary" type="button" id="compareBtn">Compare with the real page</button>'
        : ''}
    </div>`;
  wireInfo(resultEl);
  orientation(false, false);
  actionBtn.textContent = 'Check another page';
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  document.getElementById('compareBtn')?.addEventListener('click', () =>
    showReference(data.iisNo, Number(data.k))
  );

  if (data.iisNo) showPages(data.iisNo, Number(data.k));
}

// ---- Full document check ----
document.getElementById('docForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('docFile').files[0];
  if (!file) return;
  resultEl.hidden = false;
  resultEl.innerHTML = '<div class="verdict" style="--state:var(--slate)"><p class="msg">Reading the document…</p></div>';
  const fd = new FormData();
  fd.append('file', file, file.name);
  try {
    const res = await fetch('/api/verify-document', { method: 'POST', body: fd });
    renderReport(await res.json());
  } catch {
    renderPageResult({ status: 'error' });
  }
}, false);

function renderReport(rep) {
  const intact = rep.document.status === 'intact';
  const ink = intact ? 'var(--ok)' : 'var(--bad)';
  const rows = rep.pages
    .map((p) => {
      const st = PAGE_COLORS[p.status] || 'var(--slate)';
      const label = PAGE_LABELS[p.status] || p.status;
      return `<li><span class="pill" style="background:${st}">${esc(label)}</span>
              <span>p${p.position}</span>
              <span style="color:var(--muted)">${esc(p.iisNo || 'unsealed')}</span></li>`;
    })
    .join('');
  const findings = rep.findings.length
    ? `<ul class="more open" style="list-style:disc;padding-left:1.1rem;margin-top:0.7rem">
         ${rep.findings.map((f) => `<li>${esc(f)}</li>`).join('')}
       </ul>`
    : '';
  const count = rep.document.claimedPages
    ? `${rep.document.actualPages} of ${rep.document.claimedPages} pages`
    : `${rep.document.actualPages} pages`;

  resultEl.hidden = false;
  resultEl.innerHTML = `
    <div class="report" style="--state:${ink}">
      <div class="stamp">${intact ? 'Intact' : 'Tampered'}<small>${esc(rep.document.actualPages)} pp</small></div>
      <p class="eyebrow">${intact ? 'Every page verified' : 'Document altered'}</p>
      <p class="docid">${esc(rep.document.iisNo || 'Unknown document')}</p>
      <p class="pos">${esc(count)}</p>
      <ol>${rows}</ol>
      ${findings}
    </div>`;
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.getElementById('docFile').value = '';
}
