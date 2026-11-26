import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
  base64ToUint8Array,
  extractPdfPageSnippet,
  parsePdfBytes,
  sanitizePdfFilename,
  uint8ArrayToBase64
} from '../shared/pdf-parser.js';

function buildMinimalPdf(objects, catalogRef = '1 0 R') {
  const header = '%PDF-1.4\n';
  let body = '';
  for (const obj of objects) {
    body += `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
  }
  const trailer = `trailer\n<< /Root ${catalogRef} >>\n%%EOF`;
  return Buffer.from(header + body + trailer, 'latin1');
}

test('sanitizePdfFilename removes unsafe characters and ensures .pdf suffix', () => {
  assert.equal(sanitizePdfFilename('report:2026/11*?.txt'), 'report_2026_11__.txt.pdf');
  assert.equal(sanitizePdfFilename('../secret/doc'), '__secret_doc.pdf');
  assert.match(sanitizePdfFilename('   '), /^page-\d{4}-\d{2}-\d{2}\.pdf$/);
});

test('base64ToUint8Array and uint8ArrayToBase64 round-trip cleanly', () => {
  const original = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 0, 255]);
  const b64 = uint8ArrayToBase64(original);
  const restored = base64ToUint8Array(b64);
  assert.deepEqual(restored, original);
});

test('parsePdfBytes extracts title and multi-page uncompressed text', async () => {
  const pdf = buildMinimalPdf([
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, body: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>' },
    { id: 3, body: '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>' },
    { id: 4, body: '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>' },
    {
      id: 5,
      body: '<< /Length 44 >>\nstream\nBT /F1 12 Tf (Hello Page One) Tj ET\nendstream'
    },
    {
      id: 6,
      body: '<< /Length 49 >>\nstream\nBT /F1 12 Tf [(Second ) -150 (Page)] TJ ET\nendstream'
    },
    {
      id: 7,
      body: '<< /Title (Sample PDF Title) /Producer (Test) >>'
    }
  ]);

  const parsed = await parsePdfBytes(pdf);
  assert.equal(parsed.version, '1.4');
  assert.equal(parsed.pageCount, 2);
  assert.equal(parsed.title, 'Sample PDF Title');
  assert.equal(parsed.pages[0].text, 'Hello Page One');
  assert.equal(parsed.pages[1].text, 'Second Page');
  assert.equal(parsed.hasExtractableText, true);

  const snippet = extractPdfPageSnippet(parsed, 2, 100);
  assert.equal(snippet.pageNumber, 2);
  assert.equal(snippet.text, 'Second Page');
});

test('parsePdfBytes decompresses FlateDecode streams and applies ToUnicode CMap for Japanese', async () => {
  const cmapStream = `
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<0001> <0004>
endcodespacerange
2 beginbfchar
<0001> <6771>
<0002> <4EAC>
endbfchar
1 beginbfrange
<0003> <0004> [<306E> <5929>]
endbfrange
endcmap
`;
  const contentStream = 'BT /F1 12 Tf <0001000200030004> Tj ET';

  const compressedCmap = deflateSync(Buffer.from(cmapStream, 'latin1')).toString('latin1');
  const compressedContent = deflateSync(Buffer.from(contentStream, 'latin1')).toString('latin1');

  const pdf = buildMinimalPdf([
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      id: 3,
      body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>'
    },
    { id: 4, body: '<< /Type /Font /Subtype /Type0 /ToUnicode 5 0 R >>' },
    {
      id: 5,
      body: `<< /Filter /FlateDecode /Length ${compressedCmap.length} >>\nstream\n${compressedCmap}\nendstream`
    },
    {
      id: 6,
      body: `<< /Filter [/FlateDecode] /Length ${compressedContent.length} >>\nstream\n${compressedContent}\nendstream`
    }
  ]);

  const parsed = await parsePdfBytes(pdf);
  assert.equal(parsed.pageCount, 1);
  assert.equal(parsed.pages[0].text, '東京の天');
});

test('parsePdfBytes rejects non-PDF bytes', async () => {
  await assert.rejects(() => parsePdfBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /%PDF-/);
});
