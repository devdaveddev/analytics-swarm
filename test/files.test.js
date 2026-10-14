import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { parseUpload, parseDelimited, MAX_FILE_BYTES } from '../src/files.js';
import { validateCompanyInput } from '../src/guardrails.js';
import { SAMPLE_FORM } from '../src/sample.js';

// ---------- a tiny zip writer, so the tests build real .xlsx and .docx files

const CRC = (() => {
  const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  return (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();

function makeZip(files, { deflate = true } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  const names = Object.keys(files);
  for (const name of names) {
    const data = Buffer.from(files[name]);
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(CRC(data), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(CRC(data), 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const cell = (ref, v, t) => (t ? `<c r="${ref}" t="${t}"><v>${v}</v></c>` : `<c r="${ref}"><v>${v}</v></c>`);
const sheet = (rows) => `<worksheet><sheetData>${rows.map((cells, i) => `<row r="${i + 1}">${cells.join('')}</row>`).join('')}</sheetData></worksheet>`;

function workbook() {
  const strings = ['Month', 'Revenue', 'Customers', 'Marketing Spend', 'Rating', 'Comment', 'Great product &amp; fast', 'Foo', 'Bar'];
  const s = (i) => strings.indexOf(i);
  return makeZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Metrics" sheetId="1" r:id="rId1"/><sheet name="Feedback" sheetId="2" r:id="rId2"/><sheet name="Notes" sheetId="3" r:id="rId3"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${strings.map((x) => `<si><t>${x}</t></si>`).join('')}</sst>`,
    // 46023 = 2026-01-01 and 46054 = 2026-02-01 as Excel day counts
    'xl/worksheets/sheet1.xml': sheet([
      [cell('A1', s('Month'), 's'), cell('B1', s('Revenue'), 's'), cell('C1', s('Customers'), 's'), cell('D1', s('Marketing Spend'), 's')],
      [cell('A2', 46023), cell('B2', 82000), cell('C2', 310), cell('D2', 21000)],
      [cell('A3', 46054), cell('B3', 86500), cell('C3', 322)], // spend missing: the cell is simply absent
    ]),
    'xl/worksheets/sheet2.xml': sheet([
      [cell('A1', s('Rating'), 's'), cell('B1', s('Comment'), 's')],
      [cell('A2', 5), cell('B2', s('Great product &amp; fast'), 's')],
      ['<c r="A3"><v>2</v></c>', '<c r="B3" t="inlineStr"><is><t>Too slow</t></is></c>'],
    ]),
    'xl/worksheets/sheet3.xml': sheet([[cell('A1', s('Foo'), 's'), cell('B1', s('Bar'), 's')], [cell('A2', 1), cell('B2', 2)]]),
  });
}

const docx = (xml) => makeZip({ 'word/document.xml': xml });
const paragraph = (...runs) => `<w:p>${runs.map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join('')}</w:p>`;

// ---------- csv

test('csv: quoted fields keep commas and line breaks, and a BOM and semicolons are handled', () => {
  const rows = parseDelimited('﻿review;rating\r\n"Good, really good";5\r\n"Two\nlines";3\r\n');
  assert.deepEqual(rows, [['review', 'rating'], ['Good, really good', '5'], ['Two\nlines', '3']]);
  assert.deepEqual(parseDelimited('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseDelimited('say,"He said ""hi"""\n'), [['say', 'He said "hi"']]);
});

test('csv: monthly metrics are recognised from loose column names and cleaned', () => {
  const csv = 'Date,Total Revenue,Clients,Ad Spend,Cancellations\n2026-01-15,"$82,000",310,"$21,000",11\n2026-02-10,"$86,500",322,,9\n,,,,\n';
  const { items, skipped } = parseUpload('metrics.csv', Buffer.from(csv));
  assert.equal(skipped.length, 0);
  const [m] = items;
  assert.equal(m.kind, 'metrics');
  assert.deepEqual(m.columns, ['month', 'revenue', 'customers', 'marketing_spend', 'churned']);
  assert.equal(m.csv, 'month,revenue,customers,marketing_spend,churned\n2026-01,82000,310,21000,11\n2026-02,86500,322,,9');
  assert.equal(m.rows, 2);
});

test('csv: reviews are recognised, ratings are kept only when valid, and blank rows are skipped', () => {
  const csv = 'Customer Feedback,Stars\n"Loved it, honestly",5\nTerrible support,9\n\n  ,3\n';
  const { items } = parseUpload('feedback.csv', Buffer.from(csv));
  assert.equal(items[0].kind, 'reviews');
  assert.deepEqual(items[0].lines, ['5|Loved it, honestly', 'Terrible support']);
});

test('csv: an unrecognised table is skipped with the columns it found', () => {
  const { items, skipped } = parseUpload('misc.csv', Buffer.from('Foo,Bar\n1,2\n'));
  assert.equal(items.length, 0);
  assert.match(skipped[0].reason, /Found columns: Foo, Bar/);
  assert.match(skipped[0].reason, /"month" and "revenue"/);
});

test('csv: rows without a month or revenue are dropped and reported', () => {
  const { items } = parseUpload('m.csv', Buffer.from('month,revenue\n2026-01,100\n2026-02,\n,300\n'));
  assert.equal(items[0].rows, 1);
  assert.match(items[0].note, /2 row\(s\) skipped/);
});

// ---------- xlsx

test('xlsx: sheets are classified separately, Excel dates become months, and shared strings are decoded', () => {
  const { items, skipped } = parseUpload('company.xlsx', workbook());
  const metrics = items.find((i) => i.kind === 'metrics');
  assert.equal(metrics.source, 'company.xlsx · Metrics');
  assert.equal(metrics.csv, 'month,revenue,customers,marketing_spend\n2026-01,82000,310,21000\n2026-02,86500,322,');
  const reviews = items.find((i) => i.kind === 'reviews');
  assert.deepEqual(reviews.lines, ['5|Great product & fast', '2|Too slow']);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].source, /Notes/);
});

test('xlsx: the metrics it extracts pass the same validation as typed data', () => {
  const metrics = parseUpload('company.xlsx', workbook()).items.find((i) => i.kind === 'metrics');
  const verdict = validateCompanyInput({ ...SAMPLE_FORM, metrics: metrics.csv });
  assert.equal(verdict.ok, true, verdict.errors.join('; '));
  assert.equal(verdict.value.metrics.length, 2);
});

// ---------- docx and text

test('docx: paragraphs and runs are joined, entities decoded, and a short first line becomes the title', () => {
  const buf = docx(`<w:document><w:body>${paragraph('Quarterly call notes')}${paragraph('Customers asked about ', 'pricing &amp; exports.')}${paragraph('Two prospects wanted a Notion integration.')}</w:body></w:document>`);
  const { items } = parseUpload('notes.docx', buf);
  assert.equal(items[0].kind, 'document');
  assert.equal(items[0].title, 'Quarterly call notes');
  assert.equal(items[0].text, 'Customers asked about pricing & exports.\nTwo prospects wanted a Notion integration.');
});

test('txt and md: a markdown heading is the title, and the file name is used when there is none', () => {
  assert.equal(parseUpload('a.md', Buffer.from('# Market brief\nCompetitors push free tiers.')).items[0].title, 'Market brief');
  const plain = parseUpload('call-notes.txt', Buffer.from('Customers asked about pricing. Several want exports to be faster.'));
  assert.equal(plain.items[0].title, 'call-notes');
});

// ---------- refusals and safety

test('unsupported and legacy formats are refused with a way forward', () => {
  assert.throws(() => parseUpload('a.pdf', Buffer.from('%PDF-1.7')), /PDF files are not supported.*\.docx, \.txt or \.csv/);
  assert.throws(() => parseUpload('a.xls', Buffer.from('x')), /Save the sheet as \.xlsx or \.csv/);
  assert.throws(() => parseUpload('a.doc', Buffer.from('x')), /Save the document as \.docx/);
  assert.throws(() => parseUpload('a.png', Buffer.from('x')), /\.png files are not supported/);
  assert.throws(() => parseUpload('noext', Buffer.from('x')), /not supported/);
});

test('empty, oversized and corrupt files fail with clear messages', () => {
  assert.throws(() => parseUpload('a.csv', Buffer.alloc(0)), /empty/);
  assert.throws(() => parseUpload('a.csv', Buffer.alloc(MAX_FILE_BYTES + 1)), /larger than/);
  assert.throws(() => parseUpload('a.xlsx', Buffer.from('this is not a zip file at all')), /not a valid Office document/);
  assert.throws(() => parseUpload('a.docx', makeZip({ 'other.xml': '<x/>' })), /does not look like a \.docx/);
  assert.throws(() => parseUpload('a.xlsx', makeZip({ 'other.xml': '<x/>' })), /does not look like an \.xlsx/);
  assert.throws(() => parseUpload('a.docx', docx('<w:document><w:body></w:body></w:document>')), /no readable text/);
});

test('a zip bomb is refused instead of being expanded in memory', () => {
  const bomb = makeZip({ 'word/document.xml': Buffer.alloc(30 * 1024 * 1024) }); // 30 MB of zeros compresses to a few KB
  assert.ok(bomb.length < 100_000, 'the fixture really is small on disk');
  assert.throws(() => parseUpload('bomb.docx', bomb), /too large to read safely/);
});

test('stored (uncompressed) zip entries work too', () => {
  const buf = makeZip({ 'word/document.xml': `<w:document><w:body>${paragraph('A note about renewals and pricing changes.')}</w:body></w:document>` }, { deflate: false });
  assert.equal(parseUpload('s.docx', buf).items[0].kind, 'document');
});
