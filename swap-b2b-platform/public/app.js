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
  wood:       { label: 'Wood & Panels' },
  plastic:    { label: 'Plastics & Polymers' },
  components: { label: 'Components & Parts' },
  packaging:  { label: 'Packaging & Containers' },
};

/* ---------------- nav / footer ---------------- */
async function renderNav(active) {
  let account = null;
  try { const me = await api('/auth/me'); account = me.account; } catch (e) { /* not logged in */ }
  const items = [
    ['index.html', 'Start SWAP', 'home'],
    ['how-it-works.html', 'How it works', 'how'],
    ['materials.html', 'My materials', 'materials'],
    ['catalog.html', 'Catalog', 'catalog'],
    ['how-it-works.html#faq', 'FAQ', 'faq'],
  ];
  const links = items.map(([href, label, key]) => `<a href="${href}" class="${active === key ? 'active' : ''}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const accountLabel = esc(account && account.verified ? (account.company || 'Account') : 'Log in');
  document.getElementById('navRoot').innerHTML = `
    <header class="top">
      <div class="top-inner">
        <a href="index.html" class="brand">B2B <span class="brand-accent">SWAP</span></a>
        <nav class="nav-center">${links}</nav>
        <div class="top-actions">
          <a href="account.html" class="login-link ${active === 'account' ? 'active' : ''}">${accountLabel}</a>
          <a href="upload.html" class="btn btn-primary small">Upload stock list</a>
          <button type="button" class="menu-btn" id="menuBtn" aria-label="Menu" aria-expanded="false" aria-controls="mobileMenu"><span></span><span></span><span></span></button>
        </div>
      </div>
      <nav class="mobile-menu" id="mobileMenu" hidden>${links}<a href="account.html" class="${active === 'account' ? 'active' : ''}">${accountLabel}</a></nav>
    </header>`;
  // Phones: the menu links live behind the ☰ button.
  const menuBtn = document.getElementById('menuBtn');
  const menu = document.getElementById('mobileMenu');
  menuBtn.onclick = () => {
    menu.hidden = !menu.hidden;
    menuBtn.setAttribute('aria-expanded', String(!menu.hidden));
  };
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
          <a href="how-it-works.html">How it works</a><a href="materials.html">My materials</a><a href="catalog.html">Catalog</a><a href="upload.html">Upload stock list</a>
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
/** Price as shown to people: "$2,500" for published listings, the uploaded text for stock rows. */
function valueText(it) {
  if (it.isStock) return it.priceText || 'on request';
  return '$' + Number(it.price || 0).toLocaleString();
}

function specsBlockHTML(it) {
  return `<div class="cn-specs item-specs">
    <div><span>Specs</span><b>${esc(it.specs || it.condition || '—')}</b></div>
    <div><span>Quantity</span><b>${esc(it.qty || '—')}</b></div>
    <div><span>Location</span><b>${esc(it.region || '—')}</b></div>
  </div>`;
}
function pickupLineHTML(it) {
  return `<div class="cn-pickup item-pickup"><span class="pin">📍</span>Ready for pickup: <b>${esc(it.pickupLocation || it.region || '—')}</b></div>`;
}

/* ---------------- chain rendering (home + how-it-works worked example) ----------------
   Visual result of an "I have / I need" search:
     • a summary strip — what you give → what you get, hops, companies;
     • one card per step, the first ("YOU GIVE") and last ("YOU GET") marked,
       with the words that matched highlighted and a badge saying WHY the last
       item answers the request (name / material / category);
     • arrows that say who wants what ("Company wants Wood & Panels"). */
const linkIconSVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function queryWords(text) {
  return String(text || '').toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(w => w.length >= 3);
}
/** Escapes `text` and wraps every occurrence of the query words in <mark>. */
function highlightHTML(text, words) {
  const raw = String(text || '');
  const ws = [...new Set(words)].sort((a, b) => b.length - a.length).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!ws.length) return esc(raw);
  // Split the RAW text, then escape each piece — marks never land inside an entity.
  return raw.split(new RegExp(`(${ws.join('|')})`, 'gi'))
    .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}
function matchReason(it, words, material, cat) {
  const hay = `${it.title} ${it.specs || ''} ${it.desc || ''}`.toLowerCase();
  const hits = [...new Set(words.filter(w => hay.includes(w)))];
  if (hits.length) return `name matches “${hits.join(' ')}”`;
  if (material && it.material === material) return `material: ${it.materialLabel || materialInfo(material).label}`;
  if (cat && it.cat === cat) return `category: ${(CATS[cat] || {}).label || cat}`;
  return '';
}

function chainNodeHTML(it, i, last, ctx, opt = {}) {
  const role = i === 0 ? 'give' : (i === last ? 'get' : 'mid');
  const label = opt.label || (role === 'give' ? 'YOU GIVE' : role === 'get' ? 'YOU GET' : `STEP ${i}`);
  const words = role === 'give' ? ctx.haveWords : role === 'get' ? ctx.needWords : (ctx.midWords || []);
  const reason = role === 'get' && last > 0 ? matchReason(it, ctx.needWords, ctx.needMaterial, ctx.needCat)
    : role === 'give' ? matchReason(it, ctx.haveWords, ctx.haveMaterial, null) : '';
  const tag = it.materialLabel || (CATS[it.cat] || {}).label || '';
  const tel = String(it.phone || '').replace(/[^\d+]/g, '');
  return `<div class="cn cn-${role}">
      <div class="cn-top"><span class="cn-role">${label}</span></div>
      <div class="cn-body">
        ${tag ? `<span class="mat-tag">${esc(tag)}</span>` : ''}
        <div class="cn-title">${highlightHTML(it.title, words)}</div>
        ${reason ? `<div class="cn-why ${role === 'get' ? 'ok' : ''}">${role === 'get' ? '✓ ' : ''}${esc(reason)}</div>` : ''}
        <div class="cn-facts">
          <div><span>Quantity</span><b>${esc(it.qty || '—')}</b></div>
          <div><span>${it.isStock ? 'Price' : 'Est. value'}</span><b>${esc(valueText(it))}</b></div>
          ${it.region && it.region !== '—' ? `<div><span>Location</span><b>${esc(it.region)}</b></div>` : ''}
        </div>
        <div class="cn-contact">
          <b>${esc(it.owner || '—')}</b>${it.contactName ? ` · ${esc(it.contactName)}` : ''}
          ${it.phone ? `<br><a href="tel:${esc(tel)}">${esc(it.phone)}</a>` : ''}
          ${it.isStock && it.cardId ? `<br><a class="btn-link" href="card.html?id=${encodeURIComponent(it.cardId)}">Full stock list →</a>` : ''}
        </div>
        ${opt.footer || ''}
      </div>
    </div>`;
}
function chainLinkHTML(from, to) {
  const said = from.wantsText && from.wantsText !== 'open to offers' ? from.wantsText : '';
  const wants = said ? `wants<br><b>${esc(said)}</b>`
    : from.wantCat ? `wants<br><b>${esc((CATS[to.cat] || {}).label || to.cat)}</b>` : 'is<br><b>open to offers</b>';
  return `<div class="cn-link"><span class="cn-arrow">${linkIconSVG}</span><span class="cn-link-text">${esc(from.owner || 'Owner')} ${wants}</span></div>`;
}

function renderChainInto(containerEl, path, opts = {}) {
  const ctx = {
    haveWords: queryWords(opts.have), needWords: queryWords(opts.need),
    haveMaterial: opts.match && opts.match.haveMaterial, needMaterial: opts.match && opts.match.needMaterial,
    needCat: opts.match && opts.match.needCat,
  };
  const last = path.length - 1;
  let html = '';
  path.forEach((it, i) => {
    html += chainNodeHTML(it, i, last, ctx);
    if (i < last) html += chainLinkHTML(it, path[i + 1]);
  });
  const companies = new Set(path.map(p => p.owner)).size;
  const first = path[0], end = path[last];
  const alts = opts.alternatives || [];
  containerEl.innerHTML = `
    <div class="chain-summary">
      <div class="cs-end"><span class="cs-label">You give</span><b>${highlightHTML(first.title, ctx.haveWords)}</b><span class="cs-sub">${esc(first.owner || '')}</span></div>
      <div class="cs-mid"><span class="cs-hops">${last === 0 ? 'direct match' : plural(last, 'hop')}</span><span class="cs-line"></span><span class="cs-sub">${companies === 1 ? '1 company' : companies + ' companies'}</span></div>
      <div class="cs-end cs-get"><span class="cs-label">You get</span><b>${highlightHTML(end.title, ctx.needWords)}</b><span class="cs-sub">${esc(end.owner || '')}${alts.length ? ` <a class="cs-more" href="#altSuppliers">+ ${plural(alts.length, 'more supplier')}</a>` : ''}</span></div>
    </div>
    <div class="chain-head">
      <div class="chain-title">Trade chain, step by step</div>
      <div class="chain-count">${plural(path.length, 'item')} · each company gets what it wants</div>
    </div>
    <div class="chain-track">${html}</div>
    <div class="chain-actions">
      <button class="btn btn-primary small" id="startDealBtn">Confirm interest &amp; start deal</button>
      <span class="chain-note">Notifies every company in the chain by email — and by SMS if they've added a phone number.</span>
    </div>
    ${alts.length ? altSuppliersHTML(alts, ctx) : ''}`;
  // "Show this chain" on another supplier: it becomes the main result and the
  // current one joins the list, so every supplier stays one click away.
  containerEl.querySelectorAll('.alt-show').forEach(b => b.onclick = () => {
    const pick = alts[Number(b.dataset.i)];
    const rest = alts.filter(a => a !== pick);
    const others = [{ supplier: end, chain: path }, ...rest];
    renderChainInto(containerEl, pick.chain, Object.assign({}, opts, { alternatives: others }));
    if (opts.onSwitch) opts.onSwitch(pick.chain);
    containerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
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
        if (err.status === 401) toast(['Log in to confirm interest in a trade.']);
        else if (err.status === 403) toast(['Finish verifying your email and adding your company name in Account before confirming a trade.']);
        else toast(['Something went wrong confirming this trade — please try again.']);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Confirm interest & start deal';
      }
    };
  }
  containerEl.classList.add('show');
}

/** Every other company offering what was asked for, each with how to get it. */
function altSuppliersHTML(alts, ctx) {
  const cards = alts.map((a, i) => {
    const hops = a.chain ? a.chain.length - 1 : null;
    const how = a.chain
      ? `<div class="alt-how"><span>${hops === 0 ? 'Direct match' : esc(plural(hops, 'hop')) + ' chain'}</span><button type="button" class="btn btn-ghost small alt-show" data-i="${i}">Show this chain</button></div>`
      : `<div class="alt-how"><span>No swap chain yet — contact them directly</span></div>`;
    return chainNodeHTML(a.supplier, 1, 1, ctx, { label: 'ALSO FROM', footer: how }).replace('cn cn-get', 'cn cn-get cn-alt');
  }).join('');
  return `<div class="alt-suppliers" id="altSuppliers">
      <div class="chain-head">
        <div class="chain-title">Also available from ${plural(alts.length, 'other supplier')}</div>
        <div class="chain-count">same material · compare quantity, price and location</div>
      </div>
      <div class="chain-track alt-track">${cards}</div>
    </div>`;
}

/** "No chain" / "nothing like that": show the closest listings as cards, not a sentence. */
function renderSuggestionsInto(containerEl, items, words) {
  if (!items || !items.length) { containerEl.innerHTML = ''; return; }
  containerEl.innerHTML = `
    <div class="chain-head"><div class="chain-title">Closest listings on B2B SWAP</div>
      <div class="chain-count">contact them directly</div></div>
    <div class="chain-track">${items.map((it, i) => chainNodeHTML(it, 1, 99, { haveWords: [], needWords: [], midWords: words }).replace('cn-mid', 'cn-mid cn-suggest').replace(`STEP 1`, 'SIMILAR')).join('')}</div>`;
  containerEl.classList.add('show');
}

/* ---------------- stock lists (upload / materials / card pages) ---------------- */
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
let _materials = null;
async function loadMaterials() {
  if (!_materials) {
    const data = await api('/cards/material-types');
    _materials = data.materials;
  }
  return _materials;
}
function materialInfo(key) {
  return (_materials || []).find(m => m.key === key) || { key, label: key, group: 'other' };
}
function materialTag(key) {
  const m = materialInfo(key);
  return `<span class="mat-tag g-${esc(m.group)}">${esc(m.label)}</span>`;
}
function qtyText(it) {
  return it.qty ? `${it.qty}${it.unit ? ' ' + it.unit : ''}` : '—';
}
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

/* ---------------- catalog browser (catalog page + home page) ----------------
   Search + category + price + cash filters over /api/listings, which returns
   hand-published listings and every row of every uploaded stock list. */
function listingCardHTML(it) {
  const meta = CATS[it.cat] || { label: it.cat };
  const stockLine = it.isStock
    ? `<div class="item-wants">${esc(it.materialLabel || '')} · wants: ${esc(it.wantsText || 'open to offers')}</div>`
    : `<div class="item-wants">wants: ${esc(it.wantsText)}</div>`;
  return `<div class="item-card">
    <div class="item-top">
      <span class="cat-tag">${esc(meta.label)}</span>
      ${it.cashOk ? `<span class="cash-tag">+ top-up ${esc(it.cashRange)}</span>` : ''}
    </div>
    <div class="item-body">
      <div class="item-title">${esc(it.title)}</div>
      ${specsBlockHTML(it)}
      ${it.isStock ? '' : `<div class="item-desc">${esc(it.desc)}</div>`}
      ${stockLine}
      <div class="item-price-row"><span></span><b>${esc(valueText(it))}</b></div>
      <div class="item-foot"><span>${esc(it.owner)}</span><span>${esc(it.phone || '')}</span></div>
      ${it.isStock && it.cardId
        ? `<div class="cn-pickup item-pickup"><a class="btn-link" href="card.html?id=${encodeURIComponent(it.cardId)}">Full stock list →</a></div>`
        : pickupLineHTML(it)}
    </div>
  </div>`;
}

function mountCatalogBrowser(root, { limit } = {}) {
  root.innerHTML = `
    <div class="filters">
      <input type="text" data-f="search" placeholder="Search listings… e.g. aluminum sheet, plywood, АМг3">
      <select data-f="cat">
        <option value="">All categories</option>
        ${Object.keys(CATS).map(k => `<option value="${k}">${esc(CATS[k].label)}</option>`).join('')}
      </select>
      <select data-f="price">
        <option value="">Any price</option>
        <option value="0-1500">Under $1,500</option>
        <option value="1500-3000">$1,500 – $3,000</option>
        <option value="3000-6000">$3,000 – $6,000</option>
        <option value="6000-999999">$6,000+</option>
      </select>
      <label class="chk"><input type="checkbox" data-f="cash"> Open to cash top-up</label>
      <span class="count mono" data-f="count"></span>
    </div>
    <div class="item-grid" data-f="grid"></div>
    <div class="more-row" data-f="more" style="display:none;"><a class="btn btn-ghost" href="catalog.html">See the full catalog →</a></div>`;
  const $ = (f) => root.querySelector(`[data-f="${f}"]`);
  let reqId = 0, timer = null;
  async function render() {
    const my = ++reqId;
    const params = new URLSearchParams({
      search: $('search').value.trim(), cat: $('cat').value, price: $('price').value, cash: $('cash').checked ? '1' : '',
    });
    const grid = $('grid');
    grid.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">Loading listings…</p>';
    try {
      const data = await api('/listings?' + params.toString());
      if (my !== reqId) return;
      $('count').textContent = plural(data.count, 'listing');
      const shown = limit ? data.listings.slice(0, limit) : data.listings;
      grid.innerHTML = shown.map(listingCardHTML).join('') ||
        '<p style="color:var(--text-faint);font-size:13px;">No listings match those filters.</p>';
      $('more').style.display = limit && data.count > limit ? 'block' : 'none';
    } catch (err) {
      if (my === reqId) grid.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">Could not load listings — please try again.</p>';
    }
  }
  $('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 250); });
  ['cat', 'price', 'cash'].forEach(f => $(f).addEventListener('change', render));
  render();
}
