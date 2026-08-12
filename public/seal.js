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

// Read the document once: what the seal would cover, and the control number
// printed on it. Runs when the file is chosen, and the answer is kept so
// pressing Seal does not upload it a second time.
async function readDocument(file) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  try {
    const res = await fetch('/api/seal-fit', { method: 'POST', body: fd });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Ask whether the seal would land on top of anything.
// Returns null to stop, otherwise the position to seal at (null = the usual corner).
function corner(rep) {
  if (!rep) return { at: null }; // the check is a courtesy; never block on its failure
  if (rep.clear) {
    // A rule crossing the corner is normal letterhead, worth a word but not a stop.
    if (rep.ruled?.length) console.info('seal crosses a footer rule on page(s)', rep.ruled.join(', '));
    return { at: null };
  }

  const detail = rep.pages
    .filter((p) => !p.clear)
    .map((p) => {
      const bits = [];
      if (p.covered.length) bits.push(`text “${p.covered.join(' ')}”`);
      if (p.images) bits.push(`${p.images} image${p.images === 1 ? '' : 's'}`);
      if (p.shapes) bits.push(`${p.shapes} drawn shape${p.shapes === 1 ? '' : 's'}`);
      return `page ${p.k}: ${bits.join(', ')}`;
    })
    .join('\n');

  const preamble =
    'The seal would be stamped on top of existing content.\n\n' +
    detail +
    '\n\nAnything underneath will be hidden on the printed copy.\n\n';

  if (rep.moveTo) {
    // There is somewhere it fits, so moving is the sensible default and the
    // dialog leads with it.
    if (window.confirm(preamble + 'Move the seal to clear space on the page instead?')) {
      return { at: { x0: rep.moveTo.x0, y0: rep.moveTo.y0 }, moved: rep.moveTo };
    }
    return window.confirm('Seal in the usual corner anyway, covering that content?')
      ? { at: null }
      : null;
  }
  return window.confirm(preamble + 'There is no clear space on this layout. Seal anyway?')
    ? { at: null }
    : null;
}

const iisNoEl = document.getElementById('iisNo');
const fileEl = document.getElementById('sealFile');

// The pre-flight for the file currently chosen. Cleared whenever the choice
// changes, so a stale reading can never be sealed against the wrong document.
let readFor = null;

/** How the number was found, so confirming it is a real check and not a reflex. */
function evidence(c) {
  const where =
    c.pages.length === 1
      ? `page ${c.pages[0]}`
      : c.pages.length === 2
        ? `pages ${c.pages.join(' and ')}`
        : `all ${c.pages.length} pages`;
  return `Found on ${where}, ${c.labelled ? 'labelled “Control No.”' : 'unlabelled'}.`;
}

fileEl.addEventListener('change', async () => {
  readFor = null;
  const file = fileEl.files[0];
  if (!file) return;

  card(
    'var(--stamp-slate)', '…', 'Reading', 'Reading the document', '—',
    'Looking for its control number, and checking IIS through the document’s QR if the text does not say…'
  );
  const rep = await readDocument(file);
  readFor = { file, rep };

  // Answered by IIS, through the QR printed on the document. This is the only
  // way for a Special Order, whose own text leaves the number blank.
  if (rep?.source === 'iis' && rep.iisNo) {
    iisNoEl.value = rep.iisNo;
    const r = rep.record || {};
    const detail = [
      r.subject ? `Subject: ${r.subject}` : null,
      r.division ? `Division: ${r.division}` : null,
      r.status ? `Status: ${r.status}` : null,
    ].filter(Boolean);
    return card(
      'var(--stamp-slate)', 'Confirm', 'From IIS', 'Confirm this control number', rep.iisNo,
      'Read from IIS via the QR printed on this document. Check the subject matches the document in your hand, then press Seal.',
      detail.map((d) => `<p class="doc-msg">${esc(d)}</p>`).join('')
    );
  }

  const best = rep?.source === 'text' ? rep.candidates?.[0] : null;
  if (!best) {
    iisNoEl.value = '';
    const why = rep?.lookup?.reason;
    const [eyebrow, msg] =
      why === 'unreachable'
        ? ['Could not reach IIS', 'The control number is not written in this document, and IIS could not be reached to look it up. Check the connection, or type the number to seal.']
        : why === 'no-record'
          ? ['IIS has no record for this document', 'The QR on this document resolved, but IIS returned no transaction for it. Check it is the right file, or type the number to seal.']
          : ['No control number in the document', 'Nothing shaped like R1-2026-010734 was found in the text, and no IIS QR was found either. Check it is the right file, then type the number to seal.'];
    return card('var(--stamp-amber)', 'Type it', 'Not found', eyebrow, '—', msg);
  }

  iisNoEl.value = best.iisNo;
  // More than one distinct number means the document cites others. Show them
  // rather than choosing quietly — this is the field every page seal binds to.
  const others = rep.candidates.slice(1);
  const extra = others.length
    ? `<p class="doc-msg">Also found: ${others
        .map((c) => `<button type="button" class="link-btn" data-pick="${esc(c.iisNo)}">${esc(c.iisNo)}</button>`)
        .join(' ')}</p>`
    : '';
  card(
    others.length ? 'var(--stamp-amber)' : 'var(--stamp-slate)',
    others.length ? 'Check' : 'Confirm',
    others.length ? `${rep.candidates.length} found` : 'Found',
    others.length ? 'More than one number in this document' : 'Confirm this control number',
    best.iisNo,
    evidence(best) + ' Press Seal to confirm, or correct it above.',
    extra
  );
});

// Picking one of the other numbers found in the document.
resultEl.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (!pick) return;
  iisNoEl.value = pick.dataset.pick;
  card('var(--stamp-slate)', 'Confirm', 'Chosen', 'Confirm this control number', pick.dataset.pick,
    'Taken from the other numbers found in the document. Press Seal to confirm.');
});

document.getElementById('sealForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const iisNo = iisNoEl.value.trim();
  const file = fileEl.files[0];
  if (!file) return card('var(--stamp-amber)', 'Wait', 'Missing', 'No file', iisNo || '—', 'Choose the signed PDF to seal.');
  if (!iisNo) return card('var(--stamp-amber)', 'Wait', 'Missing', 'Control number required', '—', 'None was found in the document — type the IIS control number to seal.');

  card('var(--stamp-slate)', '…', 'Checking', 'Checking the corner', iisNo, 'Looking for anything the seal would cover…');
  // Reuse the reading taken when the file was chosen; only re-read if the file
  // changed underneath us.
  const rep = readFor && readFor.file === file ? readFor.rep : await readDocument(file);
  const place = corner(rep);
  if (!place) {
    return card(
      'var(--stamp-amber)', 'Stopped', 'Not sealed', 'Sealing cancelled', iisNo,
      'Nothing was sealed. Move the content out of the lower-right corner, or seal anyway if it does not matter.'
    );
  }

  card(
    'var(--stamp-slate)', '…', 'Working', 'Sealing', iisNo,
    place.moved
      ? `Stamping every page, with the seal moved ${place.moved.movedBy} pt clear of the page’s own content…`
      : 'Stamping and recording every page…'
  );
  const fd = new FormData();
  fd.append('iisNo', iisNo);
  if (place.at) fd.append('at', JSON.stringify(place.at));
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
