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

  const rows = data.pages
    .map(
      (p) => `
      <li class="pg-row${p.k === highlightK ? ' is-here' : ''}">
        <span class="pg-k">p${p.k}/${p.n}</span>
        <code class="pg-footer">${esc(p.footer)}</code>
        ${p.hasImage
          ? `<button class="pg-open" type="button" data-doc="${esc(iisNo)}" data-k="${p.k}">compare</button>`
          : '<span class="pg-open pg-none">—</span>'}
      </li>`
    )
    .join('');

  const box = document.createElement('div');
  box.className = 'pages-box';
  box.innerHTML = `
    <p class="pages-title">Pages on record — ${data.pages.length} of ${data.total}</p>
    <p class="pages-tip">
      Check the footer printed at the bottom of the sheet in your hand against the
      line below. A page that does not appear here is not part of this document,
      and a document that should have ${data.total} pages is short if you have fewer.
    </p>
    <ul class="pages-list">${rows}</ul>`;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button.pg-open');
    if (b) showReference(b.dataset.doc, Number(b.dataset.k));
  });
  resultEl.querySelector('.doc')?.appendChild(box);
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
  const diagLine = document.getElementById('diagLine');
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
        diagLine.textContent = 'decoder module failed to load — ' + e;
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
      hint.textContent = 'Fill the frame with the seal and hold steady.';
      diag.hidden = false;
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
    toggle.textContent = 'Scan seal code';
    hint.textContent = 'Point at the seal in the page’s lower-right corner.';
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
      cls = 'good'; msg = 'reading…';
    } else if (score >= 0.45) {
      cls = 'warn'; msg = 'seal found but not clean — hold steady, more light, less glare';
    } else if (pitch < MIN_PITCH) {
      cls = 'bad'; msg = 'nothing yet — move closer until the seal fills the frame';
    } else {
      cls = 'bad'; msg = 'no seal in view — centre it, and keep other dark marks out of frame';
    }
    diagLine.innerHTML =
      `px/tile <b>${pitch.toFixed(1)}</b>   match <b>${(score * 100).toFixed(0)}%</b>   ` +
      `angle <b>${info.deg || 0}°</b>\n<span class="${cls}">${msg}</span>`;
  }

  // Ship a failing frame to the server so the decoder can be worked on against
  // the real image rather than a guess about what the camera saw.
  saveBtn?.addEventListener('click', async () => {
    if (!lastFrame) { diagLine.textContent = 'no frame captured yet'; return; }
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

  toggle.addEventListener('click', () => (stream ? stop() : start()));
  return { start, stop, isActive: () => !!stream };
})();

// ---- Mode switching ----
const PAGE_STATES = {
  page_verified: { ink: 'var(--stamp-green)', stamp: 'Page ok', sub: 'Authentic seal', eyebrow: 'Authentic page seal', msg: 'This page’s seal is genuine for its position in the document.' },
  invalid_seal: { ink: 'var(--stamp-red)', stamp: 'Bad seal', sub: 'Not authentic', eyebrow: 'Invalid seal', msg: 'This code is not a valid EMB seal for this page. Treat the copy with caution.' },
  not_sealed: { ink: 'var(--stamp-amber)', stamp: 'Not sealed', sub: 'No record', eyebrow: 'No sealed page found', msg: 'No sealed page matches this code. It may be unsealed or from another document.' },
  page_count_mismatch: { ink: 'var(--stamp-amber)', stamp: 'Count off', sub: 'Page count', eyebrow: 'Page-count mismatch', msg: 'This code claims a different total page count than the registered document.' },
  invalid_code: { ink: 'var(--stamp-slate)', stamp: 'Unreadable', sub: 'Bad format', eyebrow: 'Couldn’t read that', msg: 'That doesn’t look like a page seal line. Check for typos.' },
};
const PAGE_COLORS = { verified: 'var(--stamp-green)', content_altered: 'var(--stamp-red)', not_sealed: 'var(--stamp-amber)' };
const PAGE_LABELS = { verified: 'verified', content_altered: 'altered', not_sealed: 'unsealed' };

const panels = document.querySelectorAll('.mode-panel');
document.querySelector('.modes').addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  const mode = btn.dataset.mode;
  panels.forEach((p) => (p.hidden = p.id !== 'mode-' + mode));
  pageScanner.stop();
  reference.hide();
  resultEl.hidden = true;
  resultEl.innerHTML = '';
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
  resultEl.style.setProperty('--state', 'var(--stamp-slate)');
  resultEl.innerHTML = `
    <div class="doc" style="--state:var(--stamp-slate)">
      <p class="doc-eyebrow">Reference only — nothing verified</p>
      <p class="doc-id">${esc(iisNo)}</p>
      <p class="doc-msg">Showing page ${k} as it was sealed, for comparison against the sheet you are holding.</p>
    </div>`;
  showPages(iisNo, k);
}

function renderPageResult(data) {
  if (data.status === 'loading') {
    resultEl.hidden = false;
    resultEl.innerHTML = '<div class="doc"><p class="doc-msg">Checking the seal…</p></div>';
    return;
  }
  if (data.status === 'error') {
    resultEl.hidden = false;
    resultEl.innerHTML =
      '<div class="doc" style="--state:var(--stamp-red)"><p class="doc-eyebrow">Connection problem</p><p class="doc-msg">Couldn’t reach the verification service. Check your connection and try again.</p></div>';
    return;
  }
  if (data.status === 'need_doc_and_page') {
    resultEl.hidden = false;
    resultEl.innerHTML =
      '<div class="doc" style="--state:var(--stamp-slate)"><p class="doc-eyebrow">Need a bit more</p><p class="doc-msg">Type the control number and the page number to pull up the page.</p></div>';
    return;
  }

  const s = PAGE_STATES[data.status] || PAGE_STATES.invalid_code;
  const where = data.k && data.n ? `Page ${data.k} of ${data.n}` : '';
  // A seal that checks out still cannot vouch for the words on the paper, so the
  // comparison is offered on every outcome rather than only the bad ones.
  const compare =
    data.iisNo && data.k
      ? `<button class="btn btn-ghost" type="button" id="compareBtn">Compare with the real page</button>`
      : '';
  resultEl.hidden = false;
  resultEl.style.setProperty('--state', s.ink);
  resultEl.innerHTML = `
    <div class="doc" style="--state:${s.ink}">
      <div class="stamp">${esc(s.stamp)}<small>${esc(s.sub)}</small></div>
      <p class="doc-eyebrow">${esc(s.eyebrow)}</p>
      <p class="doc-id">${esc(data.iisNo || '—')}</p>
      <p class="doc-msg">${esc(where ? where + '. ' : '')}${esc(s.msg)}</p>
      ${data.status === 'page_verified'
        ? '<p class="doc-caveat">The seal is genuine for this position in the document. It cannot confirm the wording on the sheet — for that, compare it with the page below.</p>'
        : ''}
      <div class="result-actions">
        ${compare}
        <button class="btn btn-ghost" type="button" id="againBtn">Verify another</button>
      </div>
    </div>`;
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  document.getElementById('againBtn').addEventListener('click', () => {
    resultEl.hidden = true;
    resultEl.innerHTML = '';
    reference.hide();
  });
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
  resultEl.innerHTML = '<div class="doc"><p class="doc-msg">Reading the document…</p></div>';
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
  const ink = intact ? 'var(--stamp-green)' : 'var(--stamp-red)';
  const rows = rep.pages
    .map((p) => {
      const st = PAGE_COLORS[p.status] || 'var(--stamp-slate)';
      const label = PAGE_LABELS[p.status] || p.status;
      return `<div class="page-item" style="--pstate:${st}"><span class="pnum">p${p.position}</span><span>${esc(p.iisNo || 'unsealed page')}</span><span class="pstatus">${esc(label)}</span></div>`;
    })
    .join('');
  const findings = rep.findings.length
    ? `<ul class="findings">${rep.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
    : '';
  resultEl.hidden = false;
  resultEl.style.setProperty('--state', ink);
  resultEl.innerHTML = `
    <div class="doc" style="--state:${ink}">
      <div class="stamp">${intact ? 'Intact' : 'Tampered'}<small>${rep.document.actualPages} pp</small></div>
      <div class="report-head"><span class="report-doc">${esc(rep.document.iisNo || 'Unknown document')}</span></div>
      <p class="report-sub">${rep.document.claimedPages ? esc(rep.document.actualPages + ' of ' + rep.document.claimedPages + ' pages') : esc(rep.document.actualPages + ' pages')} · ${intact ? 'all seals genuine' : rep.findings.length + ' issue' + (rep.findings.length === 1 ? '' : 's')}</p>
      <div class="pagelist">${rows}</div>
      ${findings}
      <div class="result-actions"><button class="btn btn-ghost" type="button" id="againBtn">Check another</button></div>
    </div>`;
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.getElementById('againBtn').addEventListener('click', () => {
    resultEl.hidden = true;
    resultEl.innerHTML = '';
    document.getElementById('docFile').value = '';
  });
}
