/* =====================================================================
   B2B SWAP — persistence for stock cards (one company + one uploaded
   stock-list file → many catalogue items).

   Two interchangeable implementations with the same async interface:
     • Supabase (production) — tables from supabase/002_stock_cards.sql,
       original files in the private "stock-files" Storage bucket.
     • In-memory (local dev / tests) — used automatically when Supabase
       isn't configured and NODE_ENV !== 'production'.
   ===================================================================== */
'use strict';

const BUCKET = 'stock-files';

function publicCard(c) {
  if (!c) return null;
  const { manageTokenHash, filePath, files, ...rest } = c;
  // Storage paths stay server-side; files are downloaded by index via /api/cards/:id/file?n=.
  return Object.assign(rest, { files: (files || []).map(({ path, ...f }) => f) });
}

function countCategories(items) {
  const out = {};
  items.forEach(it => { out[it.category] = (out[it.category] || 0) + 1; });
  return out;
}

/* ---------------- Supabase ---------------- */
function rowToCard(r) {
  if (!r) return null;
  return {
    id: r.id, company: r.company, contactName: r.contact_name, email: r.email, phone: r.phone,
    fileName: r.file_name, fileFormat: r.file_format, fileSize: r.file_size, filePath: r.file_path,
    itemCount: r.item_count, categories: r.categories || {}, status: r.status,
    files: Array.isArray(r.files) && r.files.length ? r.files
      : (r.file_path ? [{ name: r.file_name, path: r.file_path, format: r.file_format, size: r.file_size, items: r.item_count }] : []),
    manageTokenHash: r.manage_token_hash,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : undefined,
  };
}
function rowToItem(r) {
  const item = {
    id: r.id, cardId: r.card_id, position: r.position, category: r.category,
    title: r.title, qty: r.qty, unit: r.unit, price: r.price, specs: r.specs,
  };
  if (r.stock_cards) {
    const c = r.stock_cards;
    item.card = { id: c.id, company: c.company, contactName: c.contact_name, phone: c.phone, email: c.email };
  }
  return item;
}
function likePattern(q) {
  return '%' + String(q).toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m) + '%';
}

function createSupabaseStore(supabase) {
  const fail = (op, error) => { throw new Error(`[cards-store] ${op} failed: ${error.message}`); };

  return {
    kind: 'supabase',

    async createCard(card, items) {
      const { error } = await supabase.from('stock_cards').insert({
        id: card.id, company: card.company, contact_name: card.contactName, email: card.email, phone: card.phone,
        file_name: card.fileName, file_format: card.fileFormat, file_size: card.fileSize, file_path: card.filePath || null,
        item_count: items.length, categories: card.categories, status: 'live', manage_token_hash: card.manageTokenHash,
        files: card.files || [],
      });
      if (error) fail('createCard', error);
      try {
        await this.insertItems(card.id, items, 0);
      } catch (e) {
        await supabase.from('stock_cards').delete().eq('id', card.id); // items cascade
        throw e;
      }
      return this.getCard(card.id);
    },

    async insertItems(cardId, items, startPosition) {
      const rows = items.map((it, i) => ({
        card_id: cardId, position: startPosition + i, category: it.category, title: it.title,
        qty: it.qty || null, unit: it.unit || null, price: it.price || null, specs: it.specs || null,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase.from('stock_items').insert(rows.slice(i, i + 500));
        if (error) fail('insertItems', error);
      }
    },

    /** Owner uploads another file: its items are appended, or replace the whole list. */
    async addFile(cardId, file, items, { replace = false } = {}) {
      const card = await this.getCard(cardId);
      if (!card) return null;
      let start = 0;
      if (replace) {
        const { error } = await supabase.from('stock_items').delete().eq('card_id', cardId);
        if (error) fail('addFile clear', error);
      } else {
        const { data, error } = await supabase.from('stock_items').select('position')
          .eq('card_id', cardId).order('position', { ascending: false }).limit(1);
        if (error) fail('addFile position', error);
        start = data && data.length ? data[0].position + 1 : 0;
      }
      await this.insertItems(cardId, items, start);
      const files = replace ? [file] : [...card.files, file];
      const { error } = await supabase.from('stock_cards').update({
        files, file_name: file.name, file_format: file.format, file_size: file.size, file_path: file.path || null,
      }).eq('id', cardId);
      if (error) fail('addFile card', error);
      await this.refreshCardCategories(cardId);
      if (replace) {
        const old = card.files.map(f => f.path).filter(Boolean);
        if (old.length) await supabase.storage.from(BUCKET).remove(old).catch(() => {});
      }
      return this.getCard(cardId);
    },

    async getCard(id) {
      const { data, error } = await supabase.from('stock_cards').select('*').eq('id', id).maybeSingle();
      if (error) fail('getCard', error);
      return rowToCard(data);
    },

    async cardItems(cardId) {
      const { data, error } = await supabase.from('stock_items')
        .select('id,card_id,position,category,title,qty,unit,price,specs')
        .eq('card_id', cardId).order('position', { ascending: true }).range(0, 4999);
      if (error) fail('cardItems', error);
      return (data || []).map(rowToItem);
    },

    async listCards({ limit = 12, email } = {}) {
      let query = supabase.from('stock_cards')
        .select('id,company,contact_name,phone,email,item_count,categories,status,created_at')
        .eq('status', 'live');
      if (email) query = query.eq('email', email);
      const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
      if (error) fail('listCards', error);
      return (data || []).map(rowToCard);
    },

    async listItems({ category, q, limit = 60, offset = 0, email } = {}) {
      let query = supabase.from('stock_items')
        .select('id,card_id,position,category,title,qty,unit,price,specs,stock_cards!inner(id,company,contact_name,phone,email,status)', { count: 'exact' })
        .eq('stock_cards.status', 'live');
      if (email) query = query.eq('stock_cards.email', email);
      if (category) query = query.eq('category', category);
      if (q) query = query.ilike('search_text', likePattern(q));
      const { data, error, count } = await query.order('id', { ascending: false }).range(offset, offset + limit - 1);
      if (error) fail('listItems', error);
      return { total: count || 0, items: (data || []).map(rowToItem) };
    },

    /** Every live item with its card, for the catalog and the chain search. */
    async allLiveItems({ max = 10000 } = {}) {
      const out = [];
      for (let from = 0; from < max; from += 1000) {
        const { data, error } = await supabase.from('stock_items')
          .select('id,card_id,position,category,title,qty,unit,price,specs,stock_cards!inner(id,company,contact_name,phone,email,status)')
          .eq('stock_cards.status', 'live').order('id', { ascending: false }).range(from, from + 999);
        if (error) fail('allLiveItems', error);
        out.push(...(data || []).map(rowToItem));
        if (!data || data.length < 1000) break;
      }
      return out;
    },

    async categoryCounts({ email } = {}) {
      if (email) {
        // One owner's items only: count them directly (the view is site-wide).
        const counts = {};
        for (let from = 0; from < 20000; from += 1000) {
          const { data, error } = await supabase.from('stock_items')
            .select('category,stock_cards!inner(email,status)')
            .eq('stock_cards.status', 'live').eq('stock_cards.email', email).range(from, from + 999);
          if (error) fail('categoryCounts', error);
          (data || []).forEach(r => { counts[r.category] = (counts[r.category] || 0) + 1; });
          if (!data || data.length < 1000) break;
        }
        return counts;
      }
      const { data, error } = await supabase.from('stock_category_counts').select('category,n');
      if (error) fail('categoryCounts', error);
      const out = {};
      (data || []).forEach(r => { out[r.category] = Number(r.n); });
      return out;
    },

    async updateItemCategory(cardId, itemId, category) {
      const { data, error } = await supabase.from('stock_items')
        .update({ category }).eq('id', itemId).eq('card_id', cardId).select('id').maybeSingle();
      if (error) fail('updateItemCategory', error);
      if (!data) return false;
      await this.refreshCardCategories(cardId);
      return true;
    },

    async refreshCardCategories(cardId) {
      const items = await this.cardItems(cardId);
      const { error } = await supabase.from('stock_cards').update({ categories: countCategories(items), item_count: items.length }).eq('id', cardId);
      if (error) fail('refreshCardCategories', error);
    },

    async deleteCard(id) {
      const card = await this.getCard(id);
      if (!card) return false;
      const { error } = await supabase.from('stock_cards').delete().eq('id', id);
      if (error) fail('deleteCard', error);
      const paths = card.files.map(f => f.path).filter(Boolean);
      if (paths.length) await supabase.storage.from(BUCKET).remove(paths).catch(() => {});
      return true;
    },

    async saveFile(filePath, buffer, contentType) {
      const { error } = await supabase.storage.from(BUCKET).upload(filePath, buffer, { contentType, upsert: false });
      if (error) fail('saveFile', error);
    },

    /** Returns { url } (short-lived signed link) for uploaded file #n (default: the latest). */
    async fileDownload(card, n = card.files.length - 1) {
      const f = card.files[n];
      if (!f || !f.path) return null;
      const { data, error } = await supabase.storage.from(BUCKET)
        .createSignedUrl(f.path, 60, { download: f.name || true });
      if (error) fail('fileDownload', error);
      return { url: data.signedUrl };
    },
  };
}

/* ---------------- In-memory (dev / tests) ---------------- */
function createMemoryStore() {
  const cards = new Map();
  const items = [];
  const files = new Map();
  let nextItemId = 1;

  const live = (it) => { const c = cards.get(it.cardId); return c && c.status === 'live'; };
  const withCard = (it) => {
    const c = cards.get(it.cardId);
    return Object.assign({}, it, { card: { id: c.id, company: c.company, contactName: c.contactName, phone: c.phone, email: c.email } });
  };

  return {
    kind: 'memory',

    async createCard(card, list) {
      cards.set(card.id, Object.assign({ files: [] }, card, { itemCount: list.length, status: 'live', createdAt: Date.now() }));
      list.forEach((it, i) => items.push(Object.assign({ id: nextItemId++, cardId: card.id, position: i }, it)));
      return this.getCard(card.id);
    },
    async getCard(id) { const c = cards.get(id); return c ? Object.assign({}, c, { files: [...c.files] }) : null; },
    async addFile(cardId, file, list, { replace = false } = {}) {
      const c = cards.get(cardId);
      if (!c) return null;
      let start = 0;
      if (replace) {
        for (let i = items.length - 1; i >= 0; i--) if (items[i].cardId === cardId) items.splice(i, 1);
        c.files.forEach(f => f.path && files.delete(f.path));
        c.files = [file];
      } else {
        start = items.filter(it => it.cardId === cardId).reduce((m, it) => Math.max(m, it.position + 1), 0);
        c.files.push(file);
      }
      list.forEach((it, i) => items.push(Object.assign({ id: nextItemId++, cardId, position: start + i }, it)));
      const mine = items.filter(it => it.cardId === cardId);
      Object.assign(c, { itemCount: mine.length, categories: countCategories(mine), fileName: file.name, filePath: file.path });
      return this.getCard(cardId);
    },
    async cardItems(cardId) { return items.filter(it => it.cardId === cardId).map(it => Object.assign({}, it)); },
    async listCards({ limit = 12, email } = {}) {
      return [...cards.values()].filter(c => c.status === 'live' && (!email || c.email === email))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },
    async allLiveItems() {
      return items.filter(live).sort((a, b) => b.id - a.id).map(withCard);
    },
    async listItems({ category, q, limit = 60, offset = 0, email } = {}) {
      const needle = q ? String(q).toLowerCase() : '';
      const all = items.filter(live)
        .filter(it => !email || cards.get(it.cardId).email === email)
        .filter(it => !category || it.category === category)
        .filter(it => !needle || `${it.title} ${it.specs || ''}`.toLowerCase().includes(needle))
        .sort((a, b) => b.id - a.id);
      return { total: all.length, items: all.slice(offset, offset + limit).map(withCard) };
    },
    async categoryCounts({ email } = {}) {
      const out = {};
      items.filter(live).filter(it => !email || cards.get(it.cardId).email === email)
        .forEach(it => { out[it.category] = (out[it.category] || 0) + 1; });
      return out;
    },
    async updateItemCategory(cardId, itemId, category) {
      const it = items.find(x => x.id === Number(itemId) && x.cardId === cardId);
      if (!it) return false;
      it.category = category;
      cards.get(cardId).categories = countCategories(items.filter(x => x.cardId === cardId));
      return true;
    },
    async deleteCard(id) {
      const c = cards.get(id);
      if (!c) return false;
      cards.delete(id);
      for (let i = items.length - 1; i >= 0; i--) if (items[i].cardId === id) items.splice(i, 1);
      c.files.forEach(f => f.path && files.delete(f.path));
      return true;
    },
    async saveFile(filePath, buffer, contentType) { files.set(filePath, { buffer, contentType }); },
    async fileDownload(card, n = card.files.length - 1) {
      const meta = card.files[n];
      const f = meta && meta.path && files.get(meta.path);
      return f ? { buffer: f.buffer, contentType: f.contentType } : null;
    },
  };
}

let defaultStore = null;
function getDefaultStore() {
  if (defaultStore) return defaultStore;
  const configured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!configured && process.env.NODE_ENV !== 'production') {
    console.warn('[cards-store] Supabase not configured — stock cards are kept IN MEMORY (lost on restart). Dev only.');
    defaultStore = createMemoryStore();
  } else {
    defaultStore = createSupabaseStore(require('./supabase'));
  }
  return defaultStore;
}

module.exports = { createSupabaseStore, createMemoryStore, getDefaultStore, publicCard, BUCKET };
