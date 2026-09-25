/* =====================================================================
   B2B SWAP — stock cards: publish a company's whole stock list from ONE
   file, with no account needed — just company name + contact person,
   email and phone. Every row is catalogued by material automatically.

   POST   /api/cards                         multipart: company, contactName, email, phone, file
   GET    /api/cards                         recent cards
   GET    /api/cards/materials               material types with live item counts
   GET    /api/cards/items?cat=&q=&offset=   catalogue items across all cards
   GET    /api/cards/:id                     one card + its items
   GET    /api/cards/:id/file?n=             download uploaded file #n (default: latest)
   POST   /api/cards/:id/files               (X-Manage-Key) multipart: file, mode=append|replace
   DELETE /api/cards/:id                     (X-Manage-Key) remove the card
   PATCH  /api/cards/:id/items/:itemId       (X-Manage-Key) { category } — fix a material
   ===================================================================== */
'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { customAlphabet } = require('nanoid');

const { parseStockFile, ParseError, ACCEPTED_EXTENSIONS, MAX_ITEMS } = require('../lib/stock-parser');
const { listMaterials, isMaterial } = require('../lib/materials');
const { getDefaultStore, publicCard } = require('../lib/cards-store');

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

// Vercel Functions cap the request body at 4.5 MB, so 4 MB is the safe default there.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 4);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[\d\s()\-.]{6,25}$/;

const CONTENT_TYPES = {
  excel: 'application/vnd.ms-excel', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword', rtf: 'application/rtf', pdf: 'application/pdf',
};

function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function sanitizeFileName(name) {
  // multer hands over the multipart filename as latin1; browsers send UTF-8.
  let n = String(name || 'stock-list');
  try { n = Buffer.from(n, 'latin1').toString('utf8'); } catch (e) { /* keep as is */ }
  return n.replace(/[\\/\u0000-\u001f"<>|:*?]/g, '_').slice(-120);
}
function field(v, max) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max); }

function countCategories(items) {
  const out = {};
  items.forEach(it => { out[it.category] = (out[it.category] || 0) + 1; });
  return out;
}

function createCardsRouter({ store = getDefaultStore(), mailer = require('../mailer'), uploadLimit } = {}) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10, fieldSize: 2000 },
  });
  const uploadLimiter = uploadLimit || rateLimit({
    windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
    message: { error: 'too_many_requests', message: 'Too many uploads from this network — please try again in an hour.' },
  });

  function receiveFile(req, res, next) {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'file_too_large', message: `The file is larger than ${MAX_UPLOAD_MB} MB. Remove images or split the list and try again.` });
      }
      return res.status(400).json({ error: 'bad_upload', message: 'Upload one file in the "file" field.' });
    });
  }

  /** Validates + parses req.file. Sends a 4xx and returns null when it can't be used. */
  async function readStockUpload(req, res) {
    const fileName = sanitizeFileName(req.file.originalname);
    const ext = path.extname(fileName).slice(1).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      res.status(400).json({ error: 'unsupported_type', fields: { file: 'Upload an Excel (.xlsx, .xls), CSV, Word (.docx, .doc) or PDF file.' } });
      return null;
    }
    try {
      const parsed = await parseStockFile(req.file.buffer, fileName);
      return { fileName, ext, parsed };
    } catch (e) {
      if (e instanceof ParseError) res.status(422).json({ error: e.code, fields: { file: e.message } });
      else {
        console.error('[cards] parse failed:', e);
        res.status(422).json({ error: 'parse_failed', fields: { file: 'We could not read this file. Try saving it as .xlsx or .csv.' } });
      }
      return null;
    }
  }

  /** Keeps the original upload for download. A storage hiccup must not lose the listing itself. */
  async function storeOriginal(cardId, upload, size, buffer) {
    let filePath = `${cardId}/${Date.now()}.${upload.ext}`;
    try {
      await store.saveFile(filePath, buffer, CONTENT_TYPES[upload.parsed.format] || 'application/octet-stream');
    } catch (e) {
      console.error('[cards] original file not stored:', e.message);
      filePath = null;
    }
    return {
      name: upload.fileName, path: filePath, format: upload.parsed.format, size,
      items: upload.parsed.items.length, uploadedAt: Date.now(),
    };
  }

  async function requireManageKey(req, res) {
    const card = await store.getCard(req.params.id);
    if (!card) { res.status(404).json({ error: 'not_found' }); return null; }
    const key = req.get('X-Manage-Key') || '';
    const admin = process.env.ADMIN_TOKEN;
    const ok = (key && safeEqual(hashToken(key), card.manageTokenHash)) || (admin && admin.length >= 16 && safeEqual(key, admin));
    if (!ok) { res.status(403).json({ error: 'forbidden', message: 'This manage link is not valid for this card.' }); return null; }
    return card;
  }

  // POST /api/cards
  router.post('/', uploadLimiter, receiveFile, async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.status(400).json({ error: 'rejected' }); // honeypot — humans never see this field

    const company = field(b.company, 120);
    const contactName = field(b.contactName, 80);
    const email = field(b.email, 160).toLowerCase();
    const phone = field(b.phone, 30);
    const errors = {};
    if (company.length < 2) errors.company = 'Enter your company name.';
    if (contactName.length < 2) errors.contactName = 'Enter a contact name.';
    if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email.';
    if (!PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 6) errors.phone = 'Enter a valid phone number.';
    if (!req.file) errors.file = 'Attach your stock list (Excel, CSV, Word or PDF).';
    if (Object.keys(errors).length) return res.status(400).json({ error: 'invalid_fields', fields: errors });

    const upload = await readStockUpload(req, res);
    if (!upload) return;
    const { fileName, parsed } = upload;

    const id = nanoid();
    const manageKey = crypto.randomBytes(24).toString('base64url');
    const file = await storeOriginal(id, upload, req.file.size, req.file.buffer);

    const card = await store.createCard({
      id, company, contactName, email, phone,
      fileName, fileFormat: parsed.format, fileSize: req.file.size, filePath: file.path,
      files: [file], categories: countCategories(parsed.items), manageTokenHash: hashToken(manageKey),
    }, parsed.items);

    const origin = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const cardUrl = `${origin}/card.html?id=${id}`;
    const manageUrl = `${cardUrl}&key=${manageKey}`;
    const mail = await mailer.sendMail({
      to: email,
      subject: `Your stock list is live on B2B SWAP (${parsed.items.length} items)`,
      text: `Hi ${contactName},\n\n${company}'s stock list "${fileName}" is now live on B2B SWAP with ${parsed.items.length} items.\n\n` +
        `Public page: ${cardUrl}\nManage or remove it (keep this link private): ${manageUrl}\n\n— B2B SWAP`,
    }).catch(() => ({ sent: false }));

    res.status(201).json({
      card: publicCard(card),
      items: parsed.items.slice(0, 50),
      truncated: parsed.truncated,
      manageKey,
      cardUrl, manageUrl,
      emailSent: !!mail.sent,
    });
  });

  // GET /api/cards
  router.get('/', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    const cards = await store.listCards({ limit });
    res.json({ cards: cards.map(publicCard) });
  });

  // GET /api/cards/materials
  router.get('/materials', async (req, res) => {
    const counts = await store.categoryCounts();
    res.json({ materials: listMaterials().map(m => Object.assign(m, { count: counts[m.key] || 0 })) });
  });

  // GET /api/cards/items
  router.get('/items', async (req, res) => {
    const category = isMaterial(req.query.cat) ? req.query.cat : '';
    const q = field(req.query.q, 80);
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const result = await store.listItems({ category, q, limit, offset });
    res.json(result);
  });

  // GET /api/cards/:id
  router.get('/:id', async (req, res) => {
    const card = await store.getCard(req.params.id);
    if (!card || card.status !== 'live') return res.status(404).json({ error: 'not_found' });
    const items = await store.cardItems(card.id);
    res.json({ card: Object.assign(publicCard(card), { hasFile: card.files.some(f => f.path) }), items });
  });

  // GET /api/cards/:id/file
  router.get('/:id/file', async (req, res) => {
    const card = await store.getCard(req.params.id);
    if (!card || card.status !== 'live') return res.status(404).json({ error: 'not_found' });
    const n = req.query.n === undefined ? card.files.length - 1 : Number(req.query.n);
    if (!Number.isInteger(n) || n < 0 || n >= card.files.length) return res.status(404).json({ error: 'file_not_available' });
    const f = await store.fileDownload(card, n);
    if (!f) return res.status(404).json({ error: 'file_not_available' });
    if (f.url) return res.redirect(302, f.url);
    res.set('Content-Type', f.contentType || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(card.files[n].name || 'stock-list')}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(f.buffer);
  });

  // POST /api/cards/:id/files — the owner adds another stock file to the card.
  // mode=append (default) adds its items; mode=replace swaps the whole list for it.
  router.post('/:id/files', uploadLimiter, async (req, res, next) => {
    const card = await requireManageKey(req, res);
    if (card) { req.card = card; next(); }
  }, receiveFile, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'invalid_fields', fields: { file: 'Attach your stock list (Excel, CSV, Word or PDF).' } });
    const replace = (req.body || {}).mode === 'replace';
    const upload = await readStockUpload(req, res);
    if (!upload) return;
    const items = upload.parsed.items;
    if (!replace && req.card.itemCount + items.length > MAX_ITEMS) {
      return res.status(422).json({ error: 'too_many_items', fields: { file: `A card can hold up to ${MAX_ITEMS} items — this file would bring it to ${req.card.itemCount + items.length}. Use "Replace the list" instead.` } });
    }
    const file = await storeOriginal(req.card.id, upload, req.file.size, req.file.buffer);
    const card = await store.addFile(req.card.id, file, items, { replace });
    res.status(201).json({ card: publicCard(card), added: items.length, replaced: replace, categories: countCategories(items) });
  });

  // DELETE /api/cards/:id
  router.delete('/:id', async (req, res) => {
    const card = await requireManageKey(req, res);
    if (!card) return;
    await store.deleteCard(card.id);
    res.json({ ok: true });
  });

  // PATCH /api/cards/:id/items/:itemId { category }
  router.patch('/:id/items/:itemId', express.json(), async (req, res) => {
    const card = await requireManageKey(req, res);
    if (!card) return;
    const category = (req.body || {}).category;
    if (!isMaterial(category)) return res.status(400).json({ error: 'invalid_category' });
    const ok = await store.updateItemCategory(card.id, req.params.itemId, category);
    if (!ok) return res.status(404).json({ error: 'item_not_found' });
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createCardsRouter, MAX_UPLOAD_MB };
