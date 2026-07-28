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
  if (againBtn) againBtn.addEventListener('click', reset);
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

async function startScan() {
  if (typeof Html5Qrcode === 'undefined') {
    scanHint.textContent = 'Scanner failed to load. Use manual entry below.';
    return;
  }
  // Prefer the browser's native, hardware-accelerated QR detector when present.
  scanner = new Html5Qrcode('reader', {
    verbose: false,
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    formatsToSupport: window.Html5QrcodeSupportedFormats
      ? [window.Html5QrcodeSupportedFormats.QR_CODE]
      : undefined,
  });

  // Scan box tracks ~72% of the viewfinder's short side, so a small corner QR
  // still lands inside it without the user having to line it up perfectly.
  const qrbox = (vw, vh) => {
    const m = Math.max(160, Math.floor(Math.min(vw, vh) * 0.72));
    return { width: m, height: m };
  };

  // Ask for a high-res rear stream with continuous autofocus — small printed
  // QR codes need the pixels and the focus to resolve.
  const videoConstraints = {
    facingMode: 'environment',
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    advanced: [{ focusMode: 'continuous' }],
  };

  try {
    await scanner.start(
      videoConstraints,
      { fps: 15, qrbox, aspectRatio: 1.0 },
      (decodedText) => {
        stopScan();
        idInput.value = decodedText;
        verify(decodedText);
      },
      () => {}
    );
    scanning = true;
    viewport.classList.add('live');
    scanToggle.textContent = 'Stop camera';
    scanHint.textContent = 'Fill the box with the QR code and hold steady — get close, it’s small.';
  } catch {
    // Fall back to the simplest constraint set if the rich one is rejected.
    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 15, qrbox, aspectRatio: 1.0 },
        (decodedText) => {
          stopScan();
          idInput.value = decodedText;
          verify(decodedText);
        },
        () => {}
      );
      scanning = true;
      viewport.classList.add('live');
      scanToggle.textContent = 'Stop camera';
      scanHint.textContent = 'Fill the box with the QR code and hold steady — get close, it’s small.';
    } catch {
      scanHint.textContent = 'Couldn’t open the camera. Grant permission, or use manual entry below.';
    }
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
document.getElementById('pageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const line = document.getElementById('pageInput').value.trim();
  if (!line) return;
  const staff = document.getElementById('pageStaff').checked ? '&staff=1' : '';
  const seal = (line.match(/[0-9A-Z]{4}-[0-9A-Z]{4}/) || [])[0] || '';
  render({ status: 'loading' });
  try {
    const res = await fetch('/api/verify-page?line=' + encodeURIComponent(line) + staff);
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
