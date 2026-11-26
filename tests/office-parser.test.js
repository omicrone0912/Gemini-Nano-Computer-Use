import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  buildZipBytes,
  dataUrlToBlob,
  generateDocxPlaybookTemplate,
  parseOfficePlaybookBytes,
  readZipEntries
} from '../shared/office-parser.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function buildDeflatedZip(entries) {
  // Build ZIP with deflate-raw compression (method 8) to match Word / PowerPoint / Excel output
  const encoder = new TextEncoder();
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  const u16 = (v) => Buffer.from([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v) => Buffer.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  for (const entry of entries) {
    const nameBuf = Buffer.from(encoder.encode(entry.name));
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(encoder.encode(String(entry.data)));
    const compBuf = deflateRawSync(rawBuf);

    const lh = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(0x0800),
      u16(8), // deflate
      u16(0),
      u16(0),
      u32(0),
      u32(compBuf.length),
      u32(rawBuf.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf
    ]);
    localParts.push(lh, compBuf);

    const cd = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(8),
      u16(0),
      u16(0),
      u32(0),
      u32(compBuf.length),
      u32(rawBuf.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf
    ]);
    cdParts.push(cd);
    offset += lh.length + compBuf.length;
  }

  const cdAll = Buffer.concat(cdParts);
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cdAll.length),
    u32(offset),
    u16(0)
  ]);

  return new Uint8Array(Buffer.concat([...localParts, cdAll, eocd]));
}

test('generateDocxPlaybookTemplate produces a valid .docx archive that parses back cleanly', async () => {
  const docxBytes = generateDocxPlaybookTemplate();
  const entries = await readZipEntries(docxBytes);
  assert.ok(entries.has('word/document.xml'));
  assert.ok(entries.has('[Content_Types].xml'));

  const parsed = await parseOfficePlaybookBytes(docxBytes, 'template.docx');
  assert.match(parsed.text, /# 手順書タイトル:/);
  assert.match(parsed.text, /## 実行ステップ/);
  assert.match(parsed.text, /ask_user/);
  assert.equal(parsed.images.length, 0);
});

test('parseOfficePlaybookBytes extracts text and embedded PNG images from deflated .docx', async () => {
  const docXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>経費精算手順</w:t></w:r></w:p>
    <w:p><w:r><w:t>1. [click] 申請ボタンを押す</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><a:blip r:embed="rIdImg1"/></w:drawing></w:r></w:p>
  </w:body>
</w:document>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/screenshot1.png"/>
</Relationships>`;

  const zipBytes = buildDeflatedZip([
    { name: 'word/document.xml', data: docXml },
    { name: 'word/_rels/document.xml.rels', data: relsXml },
    { name: 'word/media/screenshot1.png', data: TINY_PNG }
  ]);

  const parsed = await parseOfficePlaybookBytes(zipBytes, 'expense.docx');
  assert.match(parsed.text, /# 経費精算手順/);
  assert.match(parsed.text, /1\. \[click\] 申請ボタンを押す/);
  assert.match(parsed.text, /\[添付画像 #1: screenshot1\.png\]/);
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0].mimeType, 'image/png');
  assert.match(parsed.images[0].stepHint, /1\. \[click\]/);

  const blob = dataUrlToBlob(parsed.images[0].dataUrl);
  assert.equal(blob.type, 'image/png');
  assert.equal(blob.size, TINY_PNG.length);
});

test('parseOfficePlaybookBytes extracts slides and images from .pptx and sheets from .xlsx', async () => {
  const pptxBytes = buildZipBytes([
    {
      name: 'ppt/slides/slide1.xml',
      data: '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><a:p><a:r><a:t>スライド1の操作</a:t></a:r></a:p><a:blip r:embed="rId2"/></p:sld>'
    },
    {
      name: 'ppt/slides/_rels/slide1.xml.rels',
      data: '<Relationships><Relationship Id="rId2" Target="../media/slide_shot.png"/></Relationships>'
    },
    { name: 'ppt/media/slide_shot.png', data: TINY_PNG }
  ]);

  const pptxParsed = await parseOfficePlaybookBytes(pptxBytes, 'guide.pptx');
  assert.match(pptxParsed.text, /## スライド 1/);
  assert.match(pptxParsed.text, /スライド1の操作/);
  assert.equal(pptxParsed.images.length, 1);

  const xlsxBytes = buildZipBytes([
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>ステップ</t></si><si><t>ログイン</t></si></sst>' },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>'
    },
    { name: 'xl/media/excel_shot.png', data: TINY_PNG }
  ]);

  const xlsxParsed = await parseOfficePlaybookBytes(xlsxBytes, 'steps.xlsx');
  assert.match(xlsxParsed.text, /ステップ \| ログイン/);
  assert.equal(xlsxParsed.images.length, 1);
});
