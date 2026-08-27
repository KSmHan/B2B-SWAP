/* =====================================================================
   B2B SWAP — client app. All data now comes from the server (/api/*) —
   accounts and listings are real and shared across devices, not stored
   per-browser like the earlier prototype.
   ===================================================================== */

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'request_failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const CATS = {
  metal:      { label: 'Metal & Raw Materials' },
  plastic:    { label: 'Plastics & Polymers' },
  components: { label: 'Components & Parts' },
  packaging:  { label: 'Packaging & Containers' },
};

/* ---------------- category illustrations (pure client-side SVG) ---------------- */
let _photoUid = 0;
function catPhoto(cat, uid) {
  const u = (uid !== undefined ? uid : _photoUid++);
  const g = `g${cat}${u}`;
  if (cat === 'metal') {
    return `<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="${g}bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E9EDF6"/><stop offset="1" stop-color="#D7DEEE"/></linearGradient>
      <linearGradient id="${g}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#B9C4DC"/><stop offset=".5" stop-color="#8FA0C4"/><stop offset="1" stop-color="#6F82AC"/></linearGradient></defs>
      <rect width="400" height="300" fill="url(#${g}bg)"/>
      <rect x="30" y="70" width="340" height="26" rx="3" fill="url(#${g}m)"/>
      <rect x="30" y="104" width="340" height="26" rx="3" fill="url(#${g}m)" opacity=".92"/>
      <rect x="30" y="138" width="340" height="26" rx="3" fill="url(#${g}m)" opacity=".84"/>
      <rect x="30" y="172" width="340" height="26" rx="3" fill="url(#${g}m)" opacity=".76"/>
      <rect x="30" y="206" width="340" height="26" rx="3" fill="url(#${g}m)" opacity=".68"/>
      <circle cx="55" cy="83" r="4" fill="#5A6B90"/><circle cx="345" cy="83" r="4" fill="#5A6B90"/>
    </svg>`;
  }
  if (cat === 'plastic') {
    let dots = '';
    const cols = ['#FFB37A', '#FF9A52', '#FFCB9B', '#F4894A', '#FFD9B8'];
    for (let i = 0; i < 70; i++) {
      const x = 20 + (i * 53) % 370, y = 30 + Math.floor(i / 8) * 34 + (i % 3) * 4, r = 8 + (i % 4);
      dots += `<circle cx="${x}" cy="${y}" r="${r}" fill="${cols[i % cols.length]}" opacity="${0.55 + ((i % 5) * 0.09)}"/>`;
    }
    return `<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="${g}bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF3E9"/><stop offset="1" stop-color="#FFE6D2"/></linearGradient></defs>
      <rect width="400" height="300" fill="url(#${g}bg)"/>${dots}</svg>`;
  }
  if (cat === 'components') {
    return `<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="${g}bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E7F8F1"/><stop offset="1" stop-color="#D3F0E3"/></linearGradient>
      <linearGradient id="${g}m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5FC79B"/><stop offset="1" stop-color="#2E9B72"/></linearGradient></defs>
      <rect width="400" height="300" fill="url(#${g}bg)"/>
      <g fill="none" stroke="url(#${g}m)" stroke-width="10"><circle cx="150" cy="150" r="58"/><circle cx="150" cy="150" r="24" fill="url(#${g}bg)"/></g>
      <g fill="url(#${g}m)"><rect x="145" y="70" width="10" height="22"/><rect x="145" y="208" width="10" height="22"/><rect x="70" y="145" width="22" height="10"/><rect x="208" y="145" width="22" height="10"/></g>
      <g fill="none" stroke="#2E9B72" stroke-width="7" opacity=".6"><circle cx="285" cy="90" r="30"/></g>
      <g fill="#2E9B72" opacity=".6"><rect x="280" y="48" width="10" height="16"/><rect x="280" y="116" width="10" height="16"/><rect x="248" y="85" width="16" height="10"/><rect x="306" y="85" width="16" height="10"/></g>
    </svg>`;
  }
  return `<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="${g}bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF0F2"/><stop offset="1" stop-color="#FFE1E6"/></linearGradient>
      <linearGradient id="${g}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E3A9AF"/><stop offset="1" stop-color="#C98088"/></linearGradient></defs>
      <rect width="400" height="300" fill="url(#${g}bg)"/>
      <g fill="url(#${g}b)" stroke="#B06D75" stroke-width="1.5"><rect x="40" y="150" width="90" height="80" rx="3"/><rect x="140" y="120" width="90" height="110" rx="3"/><rect x="240" y="160" width="90" height="70" rx="3"/></g>
      <g stroke="#8E4C54" stroke-width="1.5" opacity=".55"><line x1="85" y1="150" x2="85" y2="230"/><line x1="185" y1="120" x2="185" y2="230"/><line x1="285" y1="160" x2="285" y2="230"/></g>
    </svg>`;
}

/* ---------------- nav / footer ---------------- */
async function renderNav(active) {
  let account = null;
  try { const me = await api('/auth/me'); account = me.account; } catch (e) { /* not logged in */ }
  const items = [
    ['how-it-works.html', 'How it works', 'how'],
    ['catalog.html', 'Catalog', 'catalog'],
    ['how-it-works.html#faq', 'FAQ', 'faq'],
  ];
  const links = items.map(([href, label, key]) => `<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`).join('');
  document.getElementById('navRoot').innerHTML = `
    <header class="top">
      <div class="top-inner">
        <a href="index.html" class="brand">B2B <span class="brand-accent">SWAP</span></a>
        <nav class="nav-center">${links}</nav>
        <div class="top-actions">
          <a href="account.html" class="login-link">${account && account.verified ? (account.company || 'Account') : 'Log in'}</a>
          <a href="account.html" class="btn btn-primary small">Free to join</a>
        </div>
      </div>
    </header>`;
  return account;
}
function renderFooter() {
  const el = document.getElementById('footRoot');
  if (!el) return;
  el.innerHTML = `
    <footer>
      <div class="foot-grid">
        <div class="foot-brand">
          <a href="index.html" class="brand">B2B <span class="brand-accent">SWAP</span></a>
          <p>AI platform for industrial surplus exchange.</p>
        </div>
        <div class="foot-col"><h4>Platform</h4>
          <a href="how-it-works.html">How it works</a><a href="catalog.html">Catalog</a><a href="account.html">List surplus</a>
        </div>
        <div class="foot-col"><h4>Company</h4>
          <a href="how-it-works.html#faq">FAQ</a><a href="#">Trust &amp; safety</a><a href="#">Contact</a>
        </div>
        <div class="foot-col join"><h4>Join</h4><a href="account.html">Free to join</a></div>
      </div>
      <div class="foot-bottom"><span>© 2026 B2B SWAP.</span><span>No fees to join or trade.</span></div>
    </footer>`;
}

/* ---------------- toast ---------------- */
function toast(messages) {
  let root = document.getElementById('toastRoot');
  if (!root) { root = document.createElement('div'); root.id = 'toastRoot'; root.className = 'toast-root'; document.body.appendChild(root); }
  const arr = Array.isArray(messages) ? messages : [messages];
  arr.forEach((msg, i) => {
    setTimeout(() => {
      const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; root.appendChild(t);
      setTimeout(() => t.classList.add('show'), 10);
      setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 5200);
    }, i * 350);
  });
}

/* ---------------- product card (used on catalog + chain results) ----------------
   Layout requested: technical specs / quantity / location shown once near the
   top, and the pickup location shown once at the bottom of the card. */
function specsBlockHTML(it) {
  return `<div class="cn-specs item-specs">
    <div><span>Specs</span><b>${it.specs || it.condition || '—'}</b></div>
    <div><span>Quantity</span><b>${it.qty || '—'}</b></div>
    <div><span>Location</span><b>${it.region || '—'}</b></div>
  </div>`;
}
function pickupLineHTML(it) {
  return `<div class="cn-pickup item-pickup"><span class="pin">📍</span>Ready for pickup: <b>${it.pickupLocation || it.region || '—'}</b></div>`;
}

/* ---------------- chain rendering (home + how-it-works worked example) ---------------- */
const linkIconSVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function chainNodeHTML(it, i, isFirst) {
  const contact = !isFirst ? `<div class="cn-owner" style="margin-top:6px;">${it.owner}${it.phone ? ' · ' + it.phone : ''}</div>` : '';
  return `<div class="cn">
      <div class="cn-photo">${catPhoto(it.cat)}</div>
      <div class="cn-body">
        <div class="cn-step">${isFirst ? 'STEP 0 · YOU' : 'STEP ' + i}</div>
        <div class="cn-title">${it.title}</div>
        ${specsBlockHTML(it)}
        <div class="cn-price">est. value <b>$${Number(it.price).toLocaleString()}</b>${it.cashOk ? ` · open to +${it.cashRange}` : ''}</div>
        ${contact}
        ${pickupLineHTML(it)}
      </div>
    </div>`;
}
function renderChainInto(containerEl, path) {
  let html = '';
  path.forEach((it, i) => {
    html += chainNodeHTML(it, i, i === 0);
    if (i < path.length - 1) html += `<div class="cn-link">${linkIconSVG}</div>`;
  });
  const hops = path.length - 1;
  containerEl.innerHTML = `
    <div class="chain-head">
      <div class="chain-title">Trade chain</div>
      <div class="chain-count">${hops === 0 ? 'direct match · 1 item' : `${hops} hop${hops === 1 ? '' : 's'} · ${path.length} companies`}</div>
    </div>
    <div class="chain-track">${html}</div>
    <div class="chain-actions">
      <button class="btn btn-primary small" id="startDealBtn">Confirm interest &amp; start deal</button>
      <span class="chain-note">Notifies every company in the chain by email — and by SMS if they've added a phone number.</span>
    </div>`;
  const btn = containerEl.querySelector('#startDealBtn');
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-inline"></span>Sending…';
      try {
        const result = await api('/deals/confirm', { method: 'POST', body: { listingIds: path.map(p => p.id) } });
        const lines = result.notifications.flatMap(n => n.results.map(r => {
          if (r.sent) return `✓ ${r.channel.toUpperCase()} sent to ${r.to}`;
          if (r.reason === 'demo_company') return `${r.channel.toUpperCase()} logged for demo company ${n.owner} (not a real registered account)`;
          if (r.reason === 'not_configured') return `${r.channel.toUpperCase()} not connected on this server yet — logged instead of sent`;
          return `${r.channel.toUpperCase()} to ${r.to} failed`;
        }));
        toast(lines.length ? lines : ['Interest confirmed.']);
      } catch (err) {
        if (err.status === 401) {
          toast(['Log in to confirm interest in a trade.']);
        } else if (err.status === 403) {
          toast(['Finish verifying your email and adding your company name in Account before confirming a trade.']);
        } else {
          toast(['Something went wrong confirming this trade — please try again.']);
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Confirm interest & start deal';
      }
    };
  }
  containerEl.classList.add('show');
}
