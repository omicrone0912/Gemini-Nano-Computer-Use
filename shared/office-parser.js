import { base64ToUint8Array, uint8ArrayToBase64 } from './pdf-parser.js';

const MIME_BY_EXT = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
});

function inferMimeType(path) {
  const ext = String(path || '').split('.').pop()?.toLowerCase() || '';
  return MIME_BY_EXT[ext] || 'image/png';
}

export function dataUrlToBlob(dataUrl) {
  const str = String(dataUrl || '');
  const match = str.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    throw new Error('有効な base64 Data URL ではありません。');
  }
  const mimeType = match[1] || 'application/octet-stream';
  const bytes = base64ToUint8Array(match[2]);
  return new Blob([bytes], { type: mimeType });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readU16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function writeU16LE(buf, offset, val) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
}

function writeU32LE(buf, offset, val) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

async function inflateRawBytes(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('この実行環境では DecompressionStream が利用できません。');
  }
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const writePromise = writer.write(bytes).then(() => writer.close());
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }

  await writePromise;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Parse a standard ZIP archive (.docx / .pptx / .xlsx) into a Map<entryPath, Uint8Array>.
 */
export async function readZipEntries(inputBytes) {
  const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  if (bytes.length < 22) {
    throw new Error('有効な ZIP / Office ファイルではありません。');
  }

  // Locate End of Central Directory (0x06054b50)
  let eocdOffset = -1;
  const minOffset = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minOffset; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('ZIP ヘッダ（EOCD）が見つかりませんでした。破損しているか非対応の旧形式 (.doc/.ppt/.xls) の可能性があります。');
  }

  const totalEntries = readU16LE(bytes, eocdOffset + 10);
  const cdSize = readU32LE(bytes, eocdOffset + 12);
  const cdOffset = readU32LE(bytes, eocdOffset + 16);

  if (cdOffset + cdSize > bytes.length) {
    throw new Error('ZIP Central Directory の範囲が不正です。');
  }

  const decoder = new TextDecoder('utf-8');
  const entries = new Map();
  let ptr = cdOffset;

  for (let idx = 0; idx < totalEntries && ptr + 46 <= bytes.length; idx += 1) {
    const sig = readU32LE(bytes, ptr);
    if (sig !== 0x02014b50) break;

    const method = readU16LE(bytes, ptr + 10);
    const compressedSize = readU32LE(bytes, ptr + 20);
    const nameLen = readU16LE(bytes, ptr + 28);
    const extraLen = readU16LE(bytes, ptr + 30);
    const commentLen = readU16LE(bytes, ptr + 32);
    const localHeaderOffset = readU32LE(bytes, ptr + 42);

    const entryName = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    if (entryName.endsWith('/')) continue;
    if (localHeaderOffset + 30 > bytes.length) continue;
    if (readU32LE(bytes, localHeaderOffset) !== 0x04034b50) continue;

    const localNameLen = readU16LE(bytes, localHeaderOffset + 26);
    const localExtraLen = readU16LE(bytes, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = Math.min(bytes.length, dataStart + compressedSize);
    const compressedSlice = bytes.subarray(dataStart, dataEnd);

    let data;
    if (method === 0) {
      data = compressedSlice.slice();
    } else if (method === 8) {
      data = await inflateRawBytes(compressedSlice);
    } else {
      throw new Error(`未対応の ZIP 圧縮方式 (${method}) が使用されています: ${entryName}`);
    }

    entries.set(entryName.replace(/\\/g, '/'), data);
  }

  return entries;
}

/**
 * Build an uncompressed standard ZIP archive (method 0) from [{ name, data }].
 */
export function buildZipBytes(fileList) {
  const encoder = new TextEncoder();
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const file of fileList) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes =
      file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data ?? ''));
    const crc = crc32(dataBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    writeU32LE(localHeader, 0, 0x04034b50);
    writeU16LE(localHeader, 4, 20); // version needed
    writeU16LE(localHeader, 6, 0x0800); // UTF-8 flag
    writeU16LE(localHeader, 8, 0); // method: stored
    writeU16LE(localHeader, 10, 0);
    writeU16LE(localHeader, 12, 0);
    writeU32LE(localHeader, 14, crc);
    writeU32LE(localHeader, 18, dataBytes.length);
    writeU32LE(localHeader, 22, dataBytes.length);
    writeU16LE(localHeader, 26, nameBytes.length);
    writeU16LE(localHeader, 28, 0);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, dataBytes);

    const cdHeader = new Uint8Array(46 + nameBytes.length);
    writeU32LE(cdHeader, 0, 0x02014b50);
    writeU16LE(cdHeader, 4, 20);
    writeU16LE(cdHeader, 6, 20);
    writeU16LE(cdHeader, 8, 0x0800);
    writeU16LE(cdHeader, 10, 0);
    writeU16LE(cdHeader, 12, 0);
    writeU16LE(cdHeader, 14, 0);
    writeU32LE(cdHeader, 16, crc);
    writeU32LE(cdHeader, 20, dataBytes.length);
    writeU32LE(cdHeader, 24, dataBytes.length);
    writeU16LE(cdHeader, 28, nameBytes.length);
    writeU16LE(cdHeader, 30, 0);
    writeU16LE(cdHeader, 32, 0);
    writeU16LE(cdHeader, 34, 0);
    writeU16LE(cdHeader, 36, 0);
    writeU32LE(cdHeader, 38, 0);
    writeU32LE(cdHeader, 42, offset);
    cdHeader.set(nameBytes, 46);

    cdParts.push(cdHeader);
    offset += localHeader.length + dataBytes.length;
  }

  let cdSize = 0;
  for (const part of cdParts) cdSize += part.length;

  const eocd = new Uint8Array(22);
  writeU32LE(eocd, 0, 0x06054b50);
  writeU16LE(eocd, 4, 0);
  writeU16LE(eocd, 6, 0);
  writeU16LE(eocd, 8, fileList.length);
  writeU16LE(eocd, 10, fileList.length);
  writeU32LE(eocd, 12, cdSize);
  writeU32LE(eocd, 16, offset);
  writeU16LE(eocd, 20, 0);

  const totalLen = offset + cdSize + eocd.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of cdParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(eocd, pos);
  return out;
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function resolveZipRelPath(baseFolder, target) {
  const cleanTarget = String(target || '').replace(/\\/g, '/');
  if (cleanTarget.startsWith('/')) {
    return cleanTarget.slice(1);
  }
  const baseParts = baseFolder ? baseFolder.split('/').filter(Boolean) : [];
  for (const seg of cleanTarget.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') baseParts.pop();
    else baseParts.push(seg);
  }
  return baseParts.join('/');
}

function parseRelationships(relsXmlText, baseFolder) {
  const map = new Map();
  if (!relsXmlText) return map;
  const relRe = /<Relationship\b([^>]*?)\/?>/g;
  let match;
  while ((match = relRe.exec(relsXmlText)) !== null) {
    const attrs = match[1];
    const idMatch = attrs.match(/\bId="([^"]+)"/);
    const targetMatch = attrs.match(/\bTarget="([^"]+)"/);
    const modeMatch = attrs.match(/\bTargetMode="([^"]+)"/);
    if (!idMatch || !targetMatch) continue;
    if (modeMatch && modeMatch[1].toLowerCase() === 'external') continue;
    map.set(idMatch[1], resolveZipRelPath(baseFolder, targetMatch[1]));
  }
  return map;
}

function extractImageFromEntry(entries, mediaPath, images, imageIndexByPath, stepHint) {
  if (!mediaPath || !entries.has(mediaPath)) return null;
  if (imageIndexByPath.has(mediaPath)) {
    return imageIndexByPath.get(mediaPath);
  }
  const bytes = entries.get(mediaPath);
  const mimeType = inferMimeType(mediaPath);
  if (mimeType === 'image/svg+xml') {
    // Prompt API expects raster image formats
    return null;
  }
  const index = images.length + 1;
  const name = mediaPath.split('/').pop() || `image-${index}.png`;
  const dataUrl = `data:${mimeType};base64,${uint8ArrayToBase64(bytes)}`;
  const item = {
    index,
    name,
    mimeType,
    dataUrl,
    byteLength: bytes.length,
    stepHint: stepHint || ''
  };
  images.push(item);
  imageIndexByPath.set(mediaPath, item);
  return item;
}

function extractDocxContent(entries) {
  const decoder = new TextDecoder('utf-8');
  const docBytes = entries.get('word/document.xml');
  if (!docBytes) {
    throw new Error('Word 文書 (word/document.xml) が見つかりませんでした。');
  }

  const docXml = decoder.decode(docBytes);
  const relsBytes = entries.get('word/_rels/document.xml.rels');
  const relsMap = parseRelationships(relsBytes ? decoder.decode(relsBytes) : '', 'word');

  const images = [];
  const imageIndexByPath = new Map();
  const lines = [];
  let lastStepHint = '';

  const pRe = /<w:p\b[\s\S]*?<\/w:p>/g;
  let pMatch;
  while ((pMatch = pRe.exec(docXml)) !== null) {
    const pXml = pMatch[0];
    const styleMatch = pXml.match(/<w:pStyle\s+w:val="([^"]+)"/);
    const styleVal = styleMatch ? styleMatch[1] : '';

    // Extract text runs inside this paragraph in order
    const textParts = [];
    const tokenRe = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<a:blip\b[^>]*\br:embed="([^"]+)"[^>]*\/?>|<v:imagedata\b[^>]*\br:id="([^"]+)"[^>]*\/?>/g;
    let tok;
    const inlineMarkers = [];

    while ((tok = tokenRe.exec(pXml)) !== null) {
      if (tok[1] !== undefined) {
        textParts.push(decodeXmlEntities(tok[1]));
      } else if (tok[0].startsWith('<w:tab')) {
        textParts.push(' ');
      } else if (tok[0].startsWith('<w:br')) {
        textParts.push('\n');
      } else {
        const rId = tok[2] || tok[3];
        const mediaPath = relsMap.get(rId);
        const imgItem = extractImageFromEntry(entries, mediaPath, images, imageIndexByPath, lastStepHint);
        if (imgItem) {
          inlineMarkers.push(`[添付画像 #${imgItem.index}: ${imgItem.name}]`);
        }
      }
    }

    let line = textParts.join('').trim();
    if (line) {
      if (/Heading1|Title/i.test(styleVal) && !line.startsWith('#')) {
        line = `# ${line}`;
      } else if (/Heading2/i.test(styleVal) && !line.startsWith('#')) {
        line = `## ${line}`;
      } else if (/Heading3/i.test(styleVal) && !line.startsWith('#')) {
        line = `### ${line}`;
      }
      if (/^(?:#{1,3}\s+|\d+[.)]\s+)/.test(line)) {
        lastStepHint = line.slice(0, 120);
      }
      lines.push(line);
    }

    for (const marker of inlineMarkers) {
      lines.push(marker);
    }
  }

  // Fallback: collect any media files not referenced directly via w:p
  for (const [path] of entries) {
    if (path.startsWith('word/media/')) {
      const added = extractImageFromEntry(entries, path, images, imageIndexByPath, lastStepHint);
      if (added && !lines.some((l) => l.includes(`#${added.index}:`))) {
        lines.push(`[添付画像 #${added.index}: ${added.name}]`);
      }
    }
  }

  return { text: lines.join('\n').trim(), images };
}

function extractPptxContent(entries) {
  const decoder = new TextDecoder('utf-8');
  const slidePaths = [...entries.keys()]
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0);
      const nb = Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0);
      return na - nb;
    });

  if (slidePaths.length === 0) {
    throw new Error('PowerPoint スライド (ppt/slides/slide*.xml) が見つかりませんでした。');
  }

  const images = [];
  const imageIndexByPath = new Map();
  const lines = [];

  for (const slidePath of slidePaths) {
    const slideNum = slidePath.match(/slide(\d+)\.xml/i)?.[1] || '?';
    const stepHint = `Slide ${slideNum}`;
    lines.push(`## スライド ${slideNum}`);

    const slideXml = decoder.decode(entries.get(slidePath));
    const relsPath = slidePath.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    const relsMap = parseRelationships(
      entries.has(relsPath) ? decoder.decode(entries.get(relsPath)) : '',
      'ppt/slides'
    );

    const pRe = /<a:p\b[\s\S]*?<\/a:p>/g;
    let pMatch;
    while ((pMatch = pRe.exec(slideXml)) !== null) {
      const texts = [...pMatch[0].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) =>
        decodeXmlEntities(m[1])
      );
      const line = texts.join('').trim();
      if (line) lines.push(line);
    }

    const blipRe = /<a:blip\b[^>]*\br:embed="([^"]+)"/g;
    let bMatch;
    while ((bMatch = blipRe.exec(slideXml)) !== null) {
      const mediaPath = relsMap.get(bMatch[1]);
      const imgItem = extractImageFromEntry(entries, mediaPath, images, imageIndexByPath, stepHint);
      if (imgItem) {
        lines.push(`[添付画像 #${imgItem.index}: ${imgItem.name}]`);
      }
    }
  }

  return { text: lines.join('\n').trim(), images };
}

function extractXlsxContent(entries) {
  const decoder = new TextDecoder('utf-8');
  const sharedStrings = [];
  if (entries.has('xl/sharedStrings.xml')) {
    const ssXml = decoder.decode(entries.get('xl/sharedStrings.xml'));
    const siRe = /<si\b[\s\S]*?<\/si>/g;
    let siMatch;
    while ((siMatch = siRe.exec(ssXml)) !== null) {
      const parts = [...siMatch[0].matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) =>
        decodeXmlEntities(m[1])
      );
      sharedStrings.push(parts.join(''));
    }
  }

  const sheetPaths = [...entries.keys()]
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p))
    .sort((a, b) => {
      const na = Number(a.match(/sheet(\d+)\.xml/i)?.[1] || 0);
      const nb = Number(b.match(/sheet(\d+)\.xml/i)?.[1] || 0);
      return na - nb;
    });

  if (sheetPaths.length === 0) {
    throw new Error('Excel シート (xl/worksheets/sheet*.xml) が見つかりませんでした。');
  }

  const lines = [];
  for (const sheetPath of sheetPaths) {
    const sheetNum = sheetPath.match(/sheet(\d+)\.xml/i)?.[1] || '?';
    lines.push(`## シート ${sheetNum}`);
    const sheetXml = decoder.decode(entries.get(sheetPath));
    const rowRe = /<row\b[\s\S]*?<\/row>/g;
    let rowMatch;
    while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
      const cellVals = [];
      const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cellMatch;
      while ((cellMatch = cellRe.exec(rowMatch[0])) !== null) {
        const attrs = cellMatch[1];
        const body = cellMatch[2];
        const typeMatch = attrs.match(/\bt="([^"]+)"/);
        const cellType = typeMatch ? typeMatch[1] : '';
        if (cellType === 'inlineStr') {
          const isParts = [...body.matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) =>
            decodeXmlEntities(m[1])
          );
          cellVals.push(isParts.join(''));
        } else {
          const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
          if (vMatch) {
            if (cellType === 's') {
              const idx = Number(vMatch[1]);
              cellVals.push(sharedStrings[idx] ?? '');
            } else {
              cellVals.push(decodeXmlEntities(vMatch[1]));
            }
          }
        }
      }
      const rowLine = cellVals.map((v) => v.trim()).filter(Boolean).join(' | ');
      if (rowLine) lines.push(rowLine);
    }
  }

  const images = [];
  const imageIndexByPath = new Map();
  for (const path of [...entries.keys()].sort()) {
    if (path.startsWith('xl/media/')) {
      const imgItem = extractImageFromEntry(entries, path, images, imageIndexByPath, 'Excel 添付画像');
      if (imgItem) {
        lines.push(`[添付画像 #${imgItem.index}: ${imgItem.name}]`);
      }
    }
  }

  return { text: lines.join('\n').trim(), images };
}

/**
 * Parse a .docx, .pptx, or .xlsx file into { text, images }.
 */
export async function parseOfficePlaybookBytes(inputBytes, filename = '') {
  const lower = String(filename || '').toLowerCase();
  const entries = await readZipEntries(inputBytes);

  if (lower.endsWith('.docx') || entries.has('word/document.xml')) {
    return extractDocxContent(entries);
  }
  if (lower.endsWith('.pptx') || [...entries.keys()].some((k) => k.startsWith('ppt/slides/'))) {
    return extractPptxContent(entries);
  }
  if (lower.endsWith('.xlsx') || [...entries.keys()].some((k) => k.startsWith('xl/worksheets/'))) {
    return extractXlsxContent(entries);
  }

  throw new Error('対応していない Office ファイル形式です（.docx / .pptx / .xlsx に対応しています）。');
}

/**
 * Generate a valid .docx playbook template with image-paste placeholders
 * that can be opened directly in Microsoft Word / LibreOffice / Google Docs.
 */
export function generateDocxPlaybookTemplate() {
  const paragraphs = [
    { style: 'Heading1', text: '手順書タイトル: （例）ポータルサイト確認・PDF保存手順' },
    { style: 'Normal', text: '※ この Word (.docx) テンプレートの各ステップの下にスクリーンショット画像をそのまま貼り付けてアップロードできます。' },
    { style: 'Heading2', text: '目的' },
    { style: 'Normal', text: 'この手順書で達成したい最終ゴールを1〜2文で記述してください。' },
    { style: 'Heading2', text: '開始URL' },
    { style: 'Normal', text: 'https://example.com' },
    { style: 'Heading2', text: '前提条件・実行ルール（必守）' },
    { style: 'Normal', text: '- AI は必ずこの手順書に記載された順序・操作・条件の通りに実行してください。' },
    { style: 'Normal', text: '- 手順書に書かれていない状況・見つからない要素・入力値の不明点がある場合は、推測で進めず必ず ask_user で人間に指示を仰いでください。' },
    { style: 'Normal', text: '- 添付されたスクリーンショット画像を参考に、同じボタン・画面位置を特定してください。' },
    { style: 'Heading2', text: '実行ステップ' },
    { style: 'Normal', text: '1. [navigate] 開始URL（https://example.com）を開く。' },
    { style: 'Normal', text: '【ここに Step 1 完了時の画面スクリーンショットを貼り付け（任意）】' },
    { style: 'Normal', text: '2. [type] 検索欄（または入力欄）に「対象キーワード」を入力する。' },
    { style: 'Normal', text: '【ここに Step 2 の操作対象が分かるスクリーンショットを貼り付け】' },
    { style: 'Normal', text: '3. [click] 検索ボタン（または対象メニュー）をクリックして詳細画面へ進む。' },
    { style: 'Normal', text: '【ここに Step 3 でクリックするボタンのスクリーンショットを貼り付け】' },
    { style: 'Normal', text: '4. [download_page_pdf] 結果画面を PDF としてダウンロードし内容を確認する（必要な場合）。' },
    { style: 'Normal', text: '5. [done] 確認ポイントを満たしたことを確認し、結果を日本語で報告して完了する。' },
    { style: 'Heading2', text: '確認ポイント（完了条件）' },
    { style: 'Normal', text: '- 目的の画面が表示され、必要な情報が取得できていること。' },
    { style: 'Heading2', text: '例外・不明点発生時の対応' },
    { style: 'Normal', text: '- 参考スクリーンショットと画面が大きく異なる場合や、判断に迷う分岐が出た場合は、即座に [ask_user] で人間に確認してください。' },
    { style: 'Heading2', text: '出力形式（完了メッセージ）' },
    { style: 'Normal', text: '- 実行結果サマリー:' },
    { style: 'Normal', text: '- 取得した情報・保存ファイル:' }
  ];

  const bodyXml = paragraphs
    .map((p) => {
      const pPr =
        p.style !== 'Normal'
          ? `<w:pPr><w:pStyle w:val="${escapeXml(p.style)}"/></w:pPr>`
          : '';
      return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(p.text)}</w:t></w:r></w:p>`;
    })
    .join('');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:sz w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:sz w:val="26"/></w:rPr>
  </w:style>
</w:styles>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return buildZipBytes([
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: rootRelsXml },
    { name: 'word/_rels/document.xml.rels', data: docRelsXml },
    { name: 'word/styles.xml', data: stylesXml },
    { name: 'word/document.xml', data: documentXml }
  ]);
}
