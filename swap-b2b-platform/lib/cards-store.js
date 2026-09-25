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
  const { manageTokenHash, filePath, ...rest } = c;
  return rest;
}

/* ---------------- Supabase ---------------- */
function rowToCard(r) {
  if (!r) return null;
  return {
    id: r.id, company: r.company, contactName: r.contact_name, email: r.email, phone: r.phone,
    fileName: r.file_name, fileFormat: r.file_format, fileSize: r.file_size, filePath: r.file_path,
    itemCount: r.item_count, categories: r.categories || {}, status: r.status,
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
      });
      if (error) fail('createCard', error);
      const rows = items.map((it, i) => ({
        card_id: card.id, position: i, category: it.category, title: it.title,
        qty: it.qty || null, unit: it.unit || null, price: it.price || null, specs: it.specs || null,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error: e2 } = await supabase.from('stock_items').insert(rows.slice(i, i + 500));
        if (e2) {
          await supabase.from('stock_cards').delete().eq('id', card.id); // items cascade
          fail('createCard items', e2);
        }
      }
      return this.getCard(card.id);
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

    async listCards({ limit = 12 } = {}) {
      const { data, error } = await supabase.from('stock_cards')
        .select('id,company,contact_name,phone,email,item_count,categories,status,created_at')
        .eq('status', 'live').order('created_at', { ascending: false }).limit(limit);
      if (error) fail('listCards', error);
      return (data || []).map(rowToCard);
    },

    async listItems({ category, q, limit = 60, offset = 0 } = {}) {
      let query = supabase.from('stock_items')
        .select('id,card_id,position,category,title,qty,unit,price,specs,stock_cards!inner(id,company,contact_name,phone,email,status)', { count: 'exact' })
        .eq('stock_cards.status', 'live');
      if (category) query = query.eq('category', category);
      if (q) query = query.ilike('search_text', likePattern(q));
      const { data, error, count } = await query.order('id', { ascending: false }).range(offset, offset + limit - 1);
      if (error) fail('listItems', error);
      return { total: count || 0, items: (data || []).map(rowToItem) };
    },

    async categoryCounts() {
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
      const categories = {};
      items.forEach(it => { categories[it.category] = (categories[it.category] || 0) + 1; });
      const { error } = await supabase.from('stock_cards').update({ categories, item_count: items.length }).eq('id', cardId);
      if (error) fail('refreshCardCategories', error);
    },

    async deleteCard(id) {
      const card = await this.getCard(id);
      if (!card) return false;
      const { error } = await supabase.from('stock_cards').delete().eq('id', id);
      if (error) fail('deleteCard', error);
      if (card.filePath) await supabase.storage.from(BUCKET).remove([card.filePath]).catch(() => {});
      return true;
    },

    async saveFile(filePath, buffer, contentType) {
      const { error } = await supabase.storage.from(BUCKET).upload(filePath, buffer, { contentType, upsert: false });
      if (error) fail('saveFile', error);
    },

    /** Returns { url } (short-lived signed link) for the original upload. */
    async fileDownload(card) {
      if (!card.filePath) return null;
      const { data, error } = await supabase.storage.from(BUCKET)
        .createSignedUrl(card.filePath, 60, { download: card.fileName || true });
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
      cards.set(card.id, Object.assign({}, card, { itemCount: list.length, status: 'live', createdAt: Date.now() }));
      list.forEach((it, i) => items.push(Object.assign({ id: nextItemId++, cardId: card.id, position: i }, it)));
      return this.getCard(card.id);
    },
    async getCard(id) { const c = cards.get(id); return c ? Object.assign({}, c) : null; },
    async cardItems(cardId) { return items.filter(it => it.cardId === cardId).map(it => Object.assign({}, it)); },
    async listCards({ limit = 12 } = {}) {
      return [...cards.values()].filter(c => c.status === 'live').sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },
    async listItems({ category, q, limit = 60, offset = 0 } = {}) {
      const needle = q ? String(q).toLowerCase() : '';
      const all = items.filter(live)
        .filter(it => !category || it.category === category)
        .filter(it => !needle || `${it.title} ${it.specs || ''}`.toLowerCase().includes(needle))
        .sort((a, b) => b.id - a.id);
      return { total: all.length, items: all.slice(offset, offset + limit).map(withCard) };
    },
    async categoryCounts() {
      const out = {};
      items.filter(live).forEach(it => { out[it.category] = (out[it.category] || 0) + 1; });
      return out;
    },
    async updateItemCategory(cardId, itemId, category) {
      const it = items.find(x => x.id === Number(itemId) && x.cardId === cardId);
      if (!it) return false;
      it.category = category;
      const c = cards.get(cardId);
      c.categories = {};
      items.filter(x => x.cardId === cardId).forEach(x => { c.categories[x.category] = (c.categories[x.category] || 0) + 1; });
      return true;
    },
    async deleteCard(id) {
      const c = cards.get(id);
      if (!c) return false;
      cards.delete(id);
      for (let i = items.length - 1; i >= 0; i--) if (items[i].cardId === id) items.splice(i, 1);
      if (c.filePath) files.delete(c.filePath);
      return true;
    },
    async saveFile(filePath, buffer, contentType) { files.set(filePath, { buffer, contentType }); },
    async fileDownload(card) {
      const f = card.filePath && files.get(card.filePath);
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
