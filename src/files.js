// File import for the analysis form: CSV/TSV, XLSX, DOCX, TXT and Markdown.
// Spreadsheets are classified as monthly metrics or customer reviews from their column names; text files become documents.
// No dependencies: DOCX and XLSX are zip files, read with Node's built-in zlib. PDF and the old .xls/.doc formats are refused.
import zlib from 'node:zlib';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES = 12 * 1024 * 1024; // decompressed size cap per zip entry (zip-bomb guard)
const MAX_TABLE_ROWS = 5000;
const MAX_METRIC_ROWS = 120;
const MAX_REVIEWS = 2000;
const MAX_DOC_CHARS = 50_000;

// ---------------------------------------------------------------- zip

export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a valid Office document (zip structure not found).');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || off === 0xffffffff) throw new Error('Zip64 files are not supported.');

  const entries = new Map();
  for (let n = 0; n < total; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error('The zip directory is corrupt.');
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    entries.set(buf.toString('utf8', off + 46, off + 46 + nameLen), {
      method: buf.readUInt16LE(off + 10),
      csize: buf.readUInt32LE(off + 20),
      usize: buf.readUInt32LE(off + 24),
      local: buf.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }

  return {
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.usize > MAX_ENTRY_BYTES) throw new Error(`"${name}" is too large to read safely.`);
      if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error('The zip entry is corrupt.');
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      if (start + e.csize > buf.length) throw new Error('The zip entry is truncated.');
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method !== 8) throw new Error('This zip uses an unsupported compression method.');
      try {
        return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch {
        throw new Error(`"${name}" is corrupt or too large to read safely.`);
      }
    },
  };
}

// ---------------------------------------------------------------- xml helpers

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const codePoint = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
export const unxml = (s) =>
  String(s)
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => NAMED[n]);
const attr = (text, name) => text.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const textRuns = (xml) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

// ---------------------------------------------------------------- csv

function detectDelimiter(line) {
  const counts = [',', ';', '\t', '|'].map((d) => [d, line.split(d).length - 1]);
  return counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ',';
}

export function parseDelimited(input) {
  const text = String(input).replace(/^﻿/, '');
  const delimiter = detectDelimiter(text.split(/\r?\n/, 1)[0] ?? '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((x) => x.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length && rows.length <= MAX_TABLE_ROWS; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else field += c;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

// ---------------------------------------------------------------- xlsx

const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

export function parseXlsx(buf) {
  const zip = readZip(buf);
  const workbook = zip.read('xl/workbook.xml')?.toString('utf8');
  if (!workbook) throw new Error('This does not look like an .xlsx workbook.');
  const rels = zip.read('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sharedXml = zip.read('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));

  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml(attr(m[0], 'name') ?? 'Sheet');
    const target = targets.get(attr(m[0], 'r:id'));
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const xml = zip.read(path)?.toString('utf8');
    if (!xml) continue;

    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const idx = colIndex(attr(c[1], 'r') ?? '');
        if (idx < 0 || idx > 60) continue;
        const type = attr(c[1], 't');
        const inner = c[2] ?? '';
        const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
        let value = '';
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = textRuns(inner);
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) value = unxml(v);
        cells[idx] = value;
      }
      if (cells.some((x) => x !== undefined && String(x).trim() !== '')) rows.push(Array.from(cells, (x) => x ?? ''));
      if (rows.length >= MAX_TABLE_ROWS) break;
    }
    sheets.push({ name, rows });
  }
  if (!sheets.length) throw new Error('The workbook has no readable sheets.');
  return sheets;
}

// ---------------------------------------------------------------- docx

export function parseDocx(buf) {
  const xml = readZip(buf).read('word/document.xml')?.toString('utf8');
  if (!xml) throw new Error('This does not look like a .docx document.');
  return xml
    .split(/<\/w:p>/)
    .map((p) => [...p.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)].map((m) => (m[1] !== undefined ? unxml(m[1]) : ' ')).join('').trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- classify tables

const ALIASES = {
  month: ['month', 'date', 'period', 'time', 'month year'],
  revenue: ['revenue', 'sales', 'income', 'mrr', 'turnover', 'total revenue', 'monthly revenue'],
  customers: ['customers', 'clients', 'users', 'subscribers', 'accounts', 'active customers'],
  marketing_spend: ['marketing spend', 'marketing_spend', 'spend', 'ad spend', 'marketing', 'advertising', 'marketing cost'],
  leads: ['leads', 'new leads', 'prospects'],
  conversions: ['conversions', 'converted', 'signups', 'sign ups', 'deals', 'closed won'],
  churned: ['churned', 'churn', 'lost customers', 'cancellations', 'customers lost', 'churned customers'],
};
const REVIEW_TEXT = ['review', 'reviews', 'text', 'comment', 'comments', 'feedback', 'body', 'content', 'response', 'message', 'review text', 'customer feedback'];
const REVIEW_RATING = ['rating', 'stars', 'score', 'star rating'];

const normalise = (h) => String(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const find = (headers, names) => headers.findIndex((h) => names.includes(h));

const number = (v) => {
  const s = String(v ?? '').replace(/[^0-9.\-]/g, '');
  return s === '' || s === '-' || s === '.' ? null : Number(s);
};

// Excel stores dates as day counts. A value in this range under a month/date header is a date.
function monthLabel(v) {
  const s = String(v ?? '').trim();
  if (/^\d{5}(\.\d+)?$/.test(s) && Number(s) > 20000 && Number(s) < 80000) {
    return new Date((Number(s) - 25569) * 86400000).toISOString().slice(0, 7);
  }
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : s.slice(0, 20);
}

export function classifyTable(rows, source) {
  if (rows.length < 2) return { skipped: { source, reason: 'The table has no data rows.' } };
  const headers = rows[0].map(normalise);
  const body = rows.slice(1);

  // Monthly metrics: needs a month column and a revenue column.
  const cols = Object.fromEntries(Object.entries(ALIASES).map(([key, names]) => [key, find(headers, names)]));
  if (cols.month >= 0 && cols.revenue >= 0) {
    const keys = Object.keys(cols).filter((k) => cols[k] >= 0);
    const lines = [];
    let dropped = 0;
    for (const r of body) {
      const month = monthLabel(r[cols.month]);
      const revenue = number(r[cols.revenue]);
      if (!month || revenue === null) { dropped++; continue; }
      lines.push(keys.map((k) => {
        if (k === 'month') return month.replace(/,/g, ' ');
        const n = number(r[cols[k]]);
        return n === null ? '' : String(n);
      }).join(','));
    }
    if (!lines.length) return { skipped: { source, reason: 'No row had both a month and a revenue value.' } };
    const kept = lines.slice(0, MAX_METRIC_ROWS);
    const notes = [];
    if (dropped) notes.push(`${dropped} row(s) skipped (missing month or revenue)`);
    if (lines.length > kept.length) notes.push(`only the first ${MAX_METRIC_ROWS} rows were kept`);
    return { item: { kind: 'metrics', source, csv: `${keys.join(',')}\n${kept.join('\n')}`, rows: kept.length, columns: keys, note: notes.join('; ') } };
  }

  // Customer reviews: a text column, optionally with a star rating.
  const textCol = find(headers, REVIEW_TEXT);
  if (textCol >= 0) {
    const ratingCol = find(headers, REVIEW_RATING);
    const lines = [];
    for (const r of body) {
      const text = String(r[textCol] ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const rating = ratingCol >= 0 ? Number(r[ratingCol]) : NaN;
      lines.push(Number.isInteger(rating) && rating >= 1 && rating <= 5 ? `${rating}|${text}` : text);
    }
    if (!lines.length) return { skipped: { source, reason: 'The review column is empty.' } };
    const kept = lines.slice(0, MAX_REVIEWS);
    return {
      item: {
        kind: 'reviews', source, lines: kept, count: kept.length,
        note: lines.length > kept.length ? `only the first ${MAX_REVIEWS} reviews were kept` : '',
      },
    };
  }

  return {
    skipped: {
      source,
      reason: `Could not tell what this table holds. Found columns: ${rows[0].map((h) => String(h).trim()).filter(Boolean).slice(0, 8).join(', ') || 'none'}. Metrics need "month" and "revenue" columns; reviews need a column such as "review", "comment" or "feedback".`,
    },
  };
}

// ---------------------------------------------------------------- documents

function documentFrom(lines, name, source) {
  let title = '';
  const body = [...lines];
  if (body[0]?.startsWith('# ')) title = body.shift().slice(2).trim();
  else if (body.length > 1 && body[0].length <= 80 && !/[.!?]$/.test(body[0])) title = body.shift();
  const text = body.join('\n').trim().slice(0, MAX_DOC_CHARS);
  return {
    kind: 'document',
    source,
    title: (title || name.replace(/\.[^.]+$/, '')).slice(0, 120),
    text,
    words: (text.match(/\S+/g) ?? []).length,
    note: body.join('\n').length > MAX_DOC_CHARS ? `truncated to ${MAX_DOC_CHARS} characters` : '',
  };
}

// ---------------------------------------------------------------- entry point

const REFUSED = {
  pdf: 'PDF files are not supported yet. Export the content as .docx, .txt or .csv and upload that.',
  xls: 'The old .xls format is not supported. Save the sheet as .xlsx or .csv and upload that.',
  doc: 'The old .doc format is not supported. Save the document as .docx or .txt and upload that.',
};

export function parseUpload(name, buf) {
  if (!buf?.length) throw new Error('The file is empty.');
  if (buf.length > MAX_FILE_BYTES) throw new Error(`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (REFUSED[ext]) throw new Error(REFUSED[ext]);

  const items = [];
  const skipped = [];
  const take = (r) => (r.item ? items.push(r.item) : skipped.push(r.skipped));

  if (ext === 'csv' || ext === 'tsv') take(classifyTable(parseDelimited(buf.toString('utf8')), name));
  else if (ext === 'xlsx') parseXlsx(buf).forEach((s) => take(classifyTable(s.rows, `${name} · ${s.name}`)));
  else if (ext === 'docx') items.push(documentFrom(parseDocx(buf), name, name));
  else if (ext === 'txt' || ext === 'md') items.push(documentFrom(buf.toString('utf8').split(/\r?\n/).map((l) => l.trimEnd()).filter((l, i, all) => l || (all[i - 1] ?? '')), name, name));
  else throw new Error(`.${ext || 'unknown'} files are not supported. Use .csv, .xlsx, .docx, .txt or .md.`);

  const docs = items.filter((i) => i.kind === 'document' && !i.text);
  if (docs.length) throw new Error('The document has no readable text.');
  return { items, skipped };
}
