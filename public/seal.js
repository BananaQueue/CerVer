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

// Ask whether the seal would land on top of anything, and describe what.
// Returns true to go ahead, false to stop.
async function corner(file, iisNo) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  let rep;
  try {
    const res = await fetch('/api/seal-fit', { method: 'POST', body: fd });
    if (!res.ok) return true; // the check is a courtesy; never block on its failure
    rep = await res.json();
  } catch {
    return true;
  }
  if (rep.clear) {
    // A rule crossing the corner is normal letterhead, worth a word but not a stop.
    if (rep.ruled?.length) console.info('seal crosses a footer rule on page(s)', rep.ruled.join(', '));
    return true;
  }

  const bad = rep.pages.filter((p) => !p.clear);
  const detail = bad
    .map((p) => {
      const bits = [];
      if (p.covered.length) bits.push(`text “${p.covered.join(' ')}”`);
      if (p.images) bits.push(`${p.images} image${p.images === 1 ? '' : 's'}`);
      if (p.shapes) bits.push(`${p.shapes} drawn shape${p.shapes === 1 ? '' : 's'}`);
      return `page ${p.k}: ${bits.join(', ')}`;
    })
    .join('\n');

  return window.confirm(
    `The seal would be stamped on top of existing content.\n\n${detail}\n\n` +
      'Anything underneath will be hidden on the printed copy — a signature or an ' +
      'initial in that corner would be covered.\n\nSeal anyway?'
  );
}

document.getElementById('sealForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const iisNo = document.getElementById('iisNo').value.trim();
  const file = document.getElementById('sealFile').files[0];
  if (!iisNo) return card('var(--stamp-amber)', 'Wait', 'Missing', 'Control number required', '—', 'Enter the IIS control number first.');
  if (!file) return card('var(--stamp-amber)', 'Wait', 'Missing', 'No file', iisNo, 'Choose the signed PDF to seal.');

  card('var(--stamp-slate)', '…', 'Checking', 'Checking the corner', iisNo, 'Looking for anything the seal would cover…');
  if (!(await corner(file, iisNo))) {
    return card(
      'var(--stamp-amber)', 'Stopped', 'Not sealed', 'Sealing cancelled', iisNo,
      'Nothing was sealed. Move the content out of the lower-right corner, or seal anyway if it does not matter.'
    );
  }

  card('var(--stamp-slate)', '…', 'Working', 'Sealing', iisNo, 'Stamping and recording every page…');
  const fd = new FormData();
  fd.append('iisNo', iisNo);
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
