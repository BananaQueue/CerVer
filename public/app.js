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
  scanner = new Html5Qrcode('reader', { verbose: false });
  try {
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
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
    scanHint.textContent = 'Hold steady over the QR code.';
  } catch {
    scanHint.textContent = 'Couldn’t open the camera. Grant permission, or use manual entry below.';
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
