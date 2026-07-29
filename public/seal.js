const resultEl = document.getElementById('result');

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function card(ink, stamp, sub, eyebrow, id, msg, extra = '') {
  resultEl.hidden = false;
  resultEl.style.setProperty('--state', ink);
  resultEl.innerHTML = `
    <div class="doc" style="--state:${ink}">
      <div class="stamp">${esc(stamp)}<small>${esc(sub)}</small></div>
      <p class="doc-eyebrow">${esc(eyebrow)}</p>
      <p class="doc-id">${esc(id)}</p>
      <p class="doc-msg">${esc(msg)}</p>
      ${extra}
    </div>`;
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.getElementById('sealForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const iisNo = document.getElementById('iisNo').value.trim();
  const file = document.getElementById('sealFile').files[0];
  if (!iisNo) return card('var(--stamp-amber)', 'Wait', 'Missing', 'Control number required', '—', 'Enter the IIS control number first.');
  if (!file) return card('var(--stamp-amber)', 'Wait', 'Missing', 'No file', iisNo, 'Choose the signed PDF to seal.');

  card('var(--stamp-slate)', '…', 'Working', 'Sealing', iisNo, 'Stamping and recording every page…');
  const mark = document.getElementById('markSel')?.value || 'datamatrix';
  const fd = new FormData();
  fd.append('iisNo', iisNo);
  fd.append('mark', mark);
  fd.append('file', file, file.name);
  try {
    const res = await fetch('/api/seal', { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return card('var(--stamp-red)', 'Failed', 'Error', 'Could not seal', iisNo, err.error || 'The document could not be sealed.');
    }
    const pages = res.headers.get('X-Sealed-Pages') || '?';
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sealed-${iisNo.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    card(
      'var(--stamp-green)',
      'Sealed',
      pages + ' pp',
      'Sealed and recorded',
      iisNo,
      `${pages} page${pages === '1' ? '' : 's'} stamped. The sealed PDF has downloaded — print that copy.`,
      `<a class="link-btn" href="${url}" download="sealed-${esc(iisNo)}.pdf">Download again ↓</a>`
    );
  } catch {
    card('var(--stamp-red)', 'Failed', 'Error', 'Connection problem', iisNo, 'Couldn’t reach the server. Try again.');
  }
});
