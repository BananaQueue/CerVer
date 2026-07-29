// CerVer scan/verify client. Talks to GET /api/verify/:id.

const STATES = {
  verified_local: {
    ink: 'var(--stamp-green)',
    stamp: 'Verified',
    sub: 'On record',
    eyebrow: 'Genuine document',
    msg: 'This control number matches a document in the local registry.',
  },
  verified_live: {
    ink: 'var(--stamp-green)',
    stamp: 'Verified',
    sub: 'IIS live',
    eyebrow: 'Genuine document',
    msg: 'Confirmed against IIS just now and added to the local registry.',
  },
  needs_staff: {
    ink: 'var(--stamp-amber)',
    stamp: 'Check',
    sub: 'Not in registry',
    eyebrow: 'Not found locally',
    msg: 'This isn’t in the local registry yet. A staff member can run a live IIS check — this does not mean the document is fake.',
  },
  not_found: {
    ink: 'var(--stamp-red)',
    stamp: 'No record',
    sub: 'Not in IIS',
    eyebrow: 'No matching record',
    msg: 'No document with this control number was found, including a live IIS check. Treat the copy with caution.',
  },
  invalid: {
    ink: 'var(--stamp-slate)',
    stamp: 'Unreadable',
    sub: 'Bad format',
    eyebrow: 'Couldn’t read that',
    msg: 'That doesn’t look like an EMB control number or QR code. Check for typos and try again.',
  },
};

const FIELDS = [
  ['subject_name', 'Subject'],
  ['company_name', 'Company'],
  ['address', 'Address'],
  ['emb_id', 'EMB ID'],
  ['transaction_type', 'Type'],
];

const resultEl = document.getElementById('result');
const idInput = document.getElementById('idInput');

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function verify(id) {
  const raw = String(id ?? '').trim();
  if (!raw) return;
  render({ status: 'loading' });
  try {
    const res = await fetch('/api/verify/' + encodeURIComponent(raw));
    const data = await res.json();
    render(data);
  } catch {
    render({ status: 'error' });
  }
}

function render(data) {
  if (data.status === 'loading') {
    resultEl.hidden = false;
    resultEl.innerHTML = '<div class="doc"><p class="doc-msg">Checking the registry…</p></div>';
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  if (data.status === 'error') {
    resultEl.hidden = false;
    resultEl.innerHTML =
      '<div class="doc" style="--state:var(--stamp-red)"><p class="doc-eyebrow">Connection problem</p><p class="doc-msg">Couldn’t reach the verification service. Check your connection and try again.</p></div>';
    return;
  }

  const s = STATES[data.status] || STATES.invalid;
  const rec = data.record;
  const genuine = data.status === 'verified_local' || data.status === 'verified_live';
  const idShown = (rec && rec.iis_no) || data.id || '—';

  const rows = genuine && rec
    ? FIELDS.filter(([k]) => rec[k]).map(
        ([k, label]) =>
          `<div class="f-row"><span class="f-key">${label}</span><span class="f-val${
            k === 'emb_id' ? ' mono' : ''
          }">${esc(rec[k])}</span></div>`
      ).join('')
    : '';

  const sourceTag =
    genuine && rec
      ? `<div class="f-row"><span class="f-key">Source</span><span class="f-val"><span class="source-tag">${
          rec.source === 'iis_live' ? 'IIS · live lookup' : 'Local registry'
        }</span></span></div>`
      : '';

  const staffBtn =
    data.status === 'needs_staff'
      ? `<button class="btn btn-ghost" type="button" id="staffBtn" data-id="${esc(data.id)}">Run live IIS check (staff)</button>`
      : '';

  resultEl.hidden = false;
  resultEl.style.setProperty('--state', s.ink);
  resultEl.innerHTML = `
    <div class="doc" style="--state:${s.ink}">
      <div class="stamp">${esc(s.stamp)}<small>${esc(s.sub)}</small></div>
      <p class="doc-eyebrow">${esc(s.eyebrow)}</p>
      <p class="doc-id">${esc(idShown)}</p>
      <p class="doc-msg">${esc(s.msg)}</p>
      ${rows || sourceTag ? `<div class="fields">${rows}${sourceTag}</div>` : ''}
      <div class="result-actions">
        ${staffBtn}
        <button class="btn btn-ghost" type="button" id="againBtn">Verify another</button>
      </div>
    </div>`;
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const againBtn = document.getElementById('againBtn');
  if (againBtn)
    againBtn.addEventListener('click', () => {
      resultEl.hidden = true;
      resultEl.innerHTML = '';
      ['pgDoc', 'pgK', 'pgSeal'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const doc = document.getElementById('pgDoc');
      if (doc) doc.focus();
    });
  const staffBtnEl = document.getElementById('staffBtn');
  if (staffBtnEl) staffBtnEl.addEventListener('click', () => verifyStaff(staffBtnEl.dataset.id));
}

async function verifyStaff(id) {
  render({ status: 'loading' });
  try {
    const res = await fetch('/api/verify/' + encodeURIComponent(id) + '?staff=1');
    render(await res.json());
  } catch {
    render({ status: 'error' });
  }
}

function reset() {
  resultEl.hidden = true;
  resultEl.innerHTML = '';
  idInput.value = '';
  idInput.focus();
}

// ---- Manual form ----
document.getElementById('manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  verify(idInput.value);
});
document.getElementById('samples').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  idInput.value = btn.dataset.id;
  verify(btn.dataset.id);
});

// ---- Camera scanning (html5-qrcode) ----
let scanner = null;
let scanning = false;
const viewport = document.getElementById('viewport');
const scanToggle = document.getElementById('scanToggle');
const scanHint = document.getElementById('scanHint');

function showCameraError(e) {
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
  scanHint.textContent = msg;
}

async function startScan() {
  if (typeof Html5Qrcode === 'undefined') {
    scanHint.textContent = 'Scanner script didn’t load — reload the page and try again.';
    return;
  }
  if (!window.isSecureContext || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    scanHint.textContent =
      'The camera needs a secure page. On a phone, open the https://…:3443 address (accept the certificate warning once). On this PC use http://localhost.';
    return;
  }

  scanHint.textContent = 'Requesting camera…';

  // Probe with the browser's own getUserMedia first: it returns a proper error
  // (not html5-qrcode's opaque string) and primes the permission. `ideal` means
  // desktop webcams without a rear camera still succeed with whatever they have.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    probe.getTracks().forEach((tr) => tr.stop());
  } catch (e) {
    return showCameraError(e);
  }

  const qrbox = (vw, vh) => {
    const m = Math.max(160, Math.floor(Math.min(vw, vh) * 0.72));
    return { width: m, height: m };
  };
  const cfg = { fps: 15, qrbox, aspectRatio: 1.0 };
  const onScan = (text) => {
    stopScan();
    idInput.value = text;
    verify(text);
  };

  scanner = new Html5Qrcode('reader', {
    verbose: false,
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
  });

  try {
    // Permission is granted now, so getCameras() returns labelled device ids.
    let cams = [];
    try {
      cams = await Html5Qrcode.getCameras();
    } catch (e) {
      cams = [];
    }
    const back =
      cams.find((c) => /back|rear|environment/i.test(c.label || '')) || cams[cams.length - 1];
    // Fall back to a facingMode constraint if enumeration returned nothing.
    const source = back ? back.id : { facingMode: { ideal: 'environment' } };
    await scanner.start(source, cfg, onScan, () => {});
    scanning = true;
    viewport.classList.add('live');
    scanToggle.textContent = 'Stop camera';
    scanHint.textContent = 'Fill the box with the QR and hold steady — get close, it’s small.';
  } catch (err) {
    showCameraError(err);
  }
}

async function stopScan() {
  if (scanner && scanning) {
    try { await scanner.stop(); } catch {}
    try { await scanner.clear(); } catch {}
  }
  scanning = false;
  scanner = null;
  viewport.classList.remove('live');
  scanToggle.textContent = 'Start camera';
  scanHint.textContent = 'Point the camera at the QR code in the corner of the page.';
}

scanToggle.addEventListener('click', () => (scanning ? stopScan() : startScan()));

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
  if (mode !== 'document' && scanning) stopScan();
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

document.getElementById('pageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
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
  render({ status: 'loading' });
  try {
    const res = await fetch(
      `/api/verify-page?doc=${encodeURIComponent(doc)}&k=${encodeURIComponent(k)}&seal=${encodeURIComponent(seal)}` +
        staff
    );
    const data = await res.json();
    data._seal = seal;
    renderPageResult(data);
  } catch {
    render({ status: 'error' });
  }
});

function renderPageResult(data) {
  const s = PAGE_STATES[data.status] || PAGE_STATES.invalid_code;
  const where = data.k && data.n ? `Page ${data.k} of ${data.n}` : '';
  const staffLink =
    data.authoritative && data.authoritative.sealedPdfPath
      ? `<a class="link-btn" href="/api/page-image?doc=${encodeURIComponent(data.iisNo)}&k=${data.k}" target="_blank" rel="noopener">View authoritative page ↗</a>`
      : '';
  const frond =
    data.status === 'page_verified' && window.frondSvgMarkup && data._seal
      ? `<div class="frond-compare"><span class="frond-lbl">This page’s emblem</span><div class="frond-art">${window.frondSvgMarkup(data._seal, 76)}</div><span class="frond-hint">should match the frond printed lower-right</span></div>`
      : '';
  resultEl.hidden = false;
  resultEl.style.setProperty('--state', s.ink);
  resultEl.innerHTML = `
    <div class="doc" style="--state:${s.ink}">
      <div class="stamp">${esc(s.stamp)}<small>${esc(s.sub)}</small></div>
      <p class="doc-eyebrow">${esc(s.eyebrow)}</p>
      <p class="doc-id">${esc(data.iisNo || '—')}</p>
      <p class="doc-msg">${esc(where ? where + '. ' : '')}${esc(s.msg)}</p>
      ${frond}
      ${staffLink}
      <div class="result-actions"><button class="btn btn-ghost" type="button" id="againBtn">Verify another</button></div>
    </div>`;
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.getElementById('againBtn').addEventListener('click', () => {
    resultEl.hidden = true;
    resultEl.innerHTML = '';
  });
}

// ---- Full document check ----
document.getElementById('docForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('docFile').files[0];
  if (!file) return;
  render({ status: 'loading' });
  const fd = new FormData();
  fd.append('file', file, file.name);
  try {
    const res = await fetch('/api/verify-document', { method: 'POST', body: fd });
    renderReport(await res.json());
  } catch {
    render({ status: 'error' });
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
