/**
 * Pure JavaScript local PDF parser & utilities (zero external dependencies).
 * Works in both Chrome Extension contexts and Node.js (v18+).
 */

export function base64ToUint8Array(base64) {
  const clean = String(base64 || '').replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

export function uint8ArrayToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof btoa === 'function') {
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < arr.length; i += chunkSize) {
      const slice = arr.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...slice);
    }
    return btoa(binary);
  }
  return Buffer.from(arr).toString('base64');
}

export function sanitizePdfFilename(rawName, fallbackPrefix = 'page') {
  const fallback = `${fallbackPrefix}-${new Date().toISOString().slice(0, 10)}.pdf`;
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return fallback;
  }

  let cleaned = rawName
    .trim()
    .replace(/\.{2,}/g, '_')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip leading dots/spaces
  cleaned = cleaned.replace(/^[.\s]+/, '');
  if (!cleaned) {
    return fallback;
  }
  if (!cleaned.toLowerCase().endsWith('.pdf')) {
    cleaned = `${cleaned}.pdf`;
  }
  if (cleaned.length > 140) {
    cleaned = `${cleaned.slice(0, 136)}.pdf`;
  }
  return cleaned;
}

function bytesToLatin1(bytes) {
  const chunkSize = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    out += String.fromCharCode(...slice);
  }
  return out;
}

function latin1ToBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

async function decompressWithStream(bytes, format) {
  const ds = new DecompressionStream(format);
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

async function inflateFlateBytes(bytes) {
  if (typeof DecompressionStream === 'function') {
    try {
      return await decompressWithStream(bytes, 'deflate');
    } catch {
      try {
        return await decompressWithStream(bytes, 'deflate-raw');
      } catch {
        // Fall through
      }
    }
  }
  return bytes;
}

function findMatchingDictEnd(str, startIdx) {
  let depth = 0;
  let inLiteral = false;
  let escaped = false;
  for (let i = startIdx; i < str.length - 1; i += 1) {
    const ch = str[i];
    if (inLiteral) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === ')') inLiteral = false;
      continue;
    }
    if (ch === '(') {
      inLiteral = true;
      continue;
    }
    if (ch === '<' && str[i + 1] === '<') {
      depth += 1;
      i += 1;
    } else if (ch === '>' && str[i + 1] === '>') {
      depth -= 1;
      i += 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function parseIndirectObjects(latin1) {
  const objects = new Map();
  const objHeaderRe = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
  let match;

  while ((match = objHeaderRe.exec(latin1)) !== null) {
    const objNum = Number(match[1]);
    const genNum = Number(match[2]);
    const key = `${objNum} ${genNum}`;
    const bodyStart = match.index + match[0].length;
    const endObjIdx = latin1.indexOf('endobj', bodyStart);
    if (endObjIdx === -1) continue;

    const rawBody = latin1.slice(bodyStart, endObjIdx);
    const trimmed = rawBody.trimStart();

    let dictText = '';
    let streamBytes = null;

    if (trimmed.startsWith('<<')) {
      const dictOffsetInRaw = rawBody.indexOf('<<');
      const dictEnd = findMatchingDictEnd(rawBody, dictOffsetInRaw);
      if (dictEnd !== -1) {
        dictText = rawBody.slice(dictOffsetInRaw, dictEnd);
        const afterDict = rawBody.slice(dictEnd);
        const streamMatch = afterDict.match(/^\s*stream(?:\r\n|\r|\n)/);
        if (streamMatch) {
          const streamDataStart = dictEnd + streamMatch[0].length;
          const endStreamIdx = rawBody.lastIndexOf('endstream');
          if (endStreamIdx > streamDataStart) {
            let streamStr = rawBody.slice(streamDataStart, endStreamIdx);
            if (streamStr.endsWith('\r\n')) streamStr = streamStr.slice(0, -2);
            else if (streamStr.endsWith('\n') || streamStr.endsWith('\r')) streamStr = streamStr.slice(0, -1);
            streamBytes = latin1ToBytes(streamStr);
          }
        }
      }
    }

    objects.set(key, {
      objNum,
      genNum,
      rawBody: trimmed,
      dictText,
      streamBytes
    });

    objHeaderRe.lastIndex = endObjIdx + 6;
  }

  return objects;
}

function extractDictEntry(dictText, entryName) {
  if (!dictText) return '';
  const re = new RegExp(`/${entryName}(?=[\\s/<\\[\\(])`);
  const match = re.exec(dictText);
  if (!match) return '';

  let i = match.index + match[0].length;
  while (i < dictText.length && /\s/.test(dictText[i])) i += 1;
  if (i >= dictText.length) return '';

  if (dictText.startsWith('<<', i)) {
    const end = findMatchingDictEnd(dictText, i);
    return end !== -1 ? dictText.slice(i, end) : '';
  }

  if (dictText[i] === '[') {
    let depth = 0;
    for (let j = i; j < dictText.length; j += 1) {
      if (dictText[j] === '[') depth += 1;
      else if (dictText[j] === ']') {
        depth -= 1;
        if (depth === 0) return dictText.slice(i, j + 1);
      }
    }
    return '';
  }

  if (dictText[i] === '(') {
    let depth = 0;
    let escaped = false;
    for (let j = i; j < dictText.length; j += 1) {
      const ch = dictText[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) return dictText.slice(i, j + 1);
      }
    }
    return '';
  }

  if (dictText[i] === '<') {
    const end = dictText.indexOf('>', i);
    return end !== -1 ? dictText.slice(i, end + 1) : '';
  }

  if (dictText[i] === '/') {
    const nameMatch = dictText.slice(i).match(/^(\/[^\s/<>\[\]()]+)/);
    return nameMatch ? nameMatch[1] : '';
  }

  // Indirect ref `N G R` or scalar
  const rest = dictText.slice(i);
  const refMatch = rest.match(/^(\d+\s+\d+\s+R)/);
  if (refMatch) return refMatch[1];
  const tokenMatch = rest.match(/^([^\s/<>\[\]()]+)/);
  return tokenMatch ? tokenMatch[1] : '';
}

function parseRefKey(token) {
  const m = String(token || '').trim().match(/^(\d+)\s+(\d+)\s+R$/);
  return m ? `${Number(m[1])} ${Number(m[2])}` : null;
}

function parseAllRefs(str) {
  const refs = [];
  const re = /(\d+)\s+(\d+)\s+R/g;
  let m;
  while ((m = re.exec(String(str || ''))) !== null) {
    refs.push(`${Number(m[1])} ${Number(m[2])}`);
  }
  return refs;
}

async function getDecodedStreamText(obj) {
  if (!obj?.streamBytes) return '';
  if (obj.decodedText !== undefined) return obj.decodedText;

  let bytes = obj.streamBytes;
  const filterVal = extractDictEntry(obj.dictText, 'Filter');
  if (filterVal.includes('/FlateDecode')) {
    bytes = await inflateFlateBytes(bytes);
  }
  obj.decodedText = bytesToLatin1(bytes);
  return obj.decodedText;
}

function hexToUtf16String(hex) {
  const clean = hex.replace(/\s+/g, '');
  if (!clean) return '';
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  if (padded.length === 2) {
    return String.fromCharCode(parseInt(padded, 16));
  }
  let out = '';
  for (let i = 0; i + 3 < padded.length; i += 4) {
    const codeUnit = parseInt(padded.slice(i, i + 4), 16);
    out += String.fromCharCode(codeUnit);
  }
  if (padded.length % 4 === 2) {
    out += String.fromCharCode(parseInt(padded.slice(-2), 16));
  }
  return out;
}

function parseToUnicodeCMap(cmapText) {
  const map = new Map();
  let codeByteLen = 0;

  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let block;
  while ((block = bfcharRe.exec(cmapText)) !== null) {
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let pair;
    while ((pair = pairRe.exec(block[1])) !== null) {
      const srcHex = pair[1].toUpperCase();
      const dstStr = hexToUtf16String(pair[2]);
      codeByteLen = Math.max(codeByteLen, Math.ceil(srcHex.length / 2));
      map.set(srcHex, dstStr);
    }
  }

  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = bfrangeRe.exec(cmapText)) !== null) {
    const rangeRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let range;
    while ((range = rangeRe.exec(block[1])) !== null) {
      const startHex = range[1];
      const endHex = range[2];
      const hexWidth = startHex.length;
      const startNum = parseInt(startHex, 16);
      const endNum = parseInt(endHex, 16);
      codeByteLen = Math.max(codeByteLen, Math.ceil(hexWidth / 2));

      if (endNum < startNum || endNum - startNum > 2048) continue;

      if (range[3]) {
        const baseDstHex = range[3];
        const baseDstNum = parseInt(baseDstHex, 16);
        const dstWidth = baseDstHex.length;
        for (let code = startNum; code <= endNum; code += 1) {
          const srcHex = code.toString(16).toUpperCase().padStart(hexWidth, '0');
          const dstHex = (baseDstNum + (code - startNum))
            .toString(16)
            .toUpperCase()
            .padStart(dstWidth, '0');
          map.set(srcHex, hexToUtf16String(dstHex));
        }
      } else if (range[4]) {
        const targets = [...range[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => m[1]);
        for (let code = startNum, idx = 0; code <= endNum && idx < targets.length; code += 1, idx += 1) {
          const srcHex = code.toString(16).toUpperCase().padStart(hexWidth, '0');
          map.set(srcHex, hexToUtf16String(targets[idx]));
        }
      }
    }
  }

  return { map, codeByteLen: codeByteLen || 2 };
}

function decodePdfLiteralString(rawInsideParens) {
  let bytes = [];
  for (let i = 0; i < rawInsideParens.length; i += 1) {
    const ch = rawInsideParens[i];
    if (ch !== '\\') {
      bytes.push(ch.charCodeAt(0) & 0xff);
      continue;
    }
    i += 1;
    if (i >= rawInsideParens.length) break;
    const esc = rawInsideParens[i];
    if (esc === 'n') bytes.push(10);
    else if (esc === 'r') bytes.push(13);
    else if (esc === 't') bytes.push(9);
    else if (esc === 'b') bytes.push(8);
    else if (esc === 'f') bytes.push(12);
    else if (esc === '(' || esc === ')' || esc === '\\') bytes.push(esc.charCodeAt(0));
    else if (esc === '\r') {
      if (rawInsideParens[i + 1] === '\n') i += 1;
    } else if (esc === '\n') {
      // Line continuation
    } else if (/[0-7]/.test(esc)) {
      let oct = esc;
      for (let k = 0; k < 2 && i + 1 < rawInsideParens.length && /[0-7]/.test(rawInsideParens[i + 1]); k += 1) {
        i += 1;
        oct += rawInsideParens[i];
      }
      bytes.push(parseInt(oct, 8) & 0xff);
    } else {
      bytes.push(esc.charCodeAt(0) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function decodeBytesWithFont(bytes, cmapInfo) {
  if (!bytes || bytes.length === 0) return '';
  if (cmapInfo && cmapInfo.map.size > 0) {
    const step = cmapInfo.codeByteLen === 1 ? 1 : 2;
    let out = '';
    for (let i = 0; i < bytes.length; i += step) {
      if (step === 2 && i + 1 < bytes.length) {
        const hex2 = ((bytes[i] << 8) | bytes[i + 1])
          .toString(16)
          .toUpperCase()
          .padStart(4, '0');
        if (cmapInfo.map.has(hex2)) {
          out += cmapInfo.map.get(hex2);
          continue;
        }
      }
      const hex1 = bytes[i].toString(16).toUpperCase().padStart(2, '0');
      if (cmapInfo.map.has(hex1)) {
        out += cmapInfo.map.get(hex1);
      } else if (bytes[i] >= 32 && bytes[i] <= 126) {
        out += String.fromCharCode(bytes[i]);
      }
    }
    return out;
  }

  // UTF-16BE BOM check
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }

  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === 10 || b === 13 || b === 9 || (b >= 32 && b <= 126) || b >= 160) {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

function decodeHexTokenBytes(hexToken) {
  const clean = hexToken.replace(/\s+/g, '');
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < padded.length; i += 2) {
    bytes[i / 2] = parseInt(padded.slice(i, i + 2), 16);
  }
  return bytes;
}

function extractTextFromContentStream(contentText, fontCmaps) {
  const lines = [];
  let currentLine = '';
  let currentFont = null;

  const flushLine = () => {
    const trimmed = currentLine.replace(/[ \t]+/g, ' ').trim();
    if (trimmed) lines.push(trimmed);
    currentLine = '';
  };

  // Tokenize PDF content stream sequentially
  let i = 0;
  const len = contentText.length;
  const operandStack = [];

  while (i < len) {
    const ch = contentText[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // Comment
    if (ch === '%') {
      while (i < len && contentText[i] !== '\n' && contentText[i] !== '\r') i += 1;
      continue;
    }

    // Literal string (...)
    if (ch === '(') {
      let depth = 0;
      let escaped = false;
      const start = i + 1;
      for (; i < len; i += 1) {
        const c = contentText[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (c === '\\') {
          escaped = true;
          continue;
        }
        if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const rawInner = contentText.slice(start, i);
      operandStack.push({ type: 'bytes', value: decodePdfLiteralString(rawInner) });
      i += 1;
      continue;
    }

    // Hex string <...> (not << >>)
    if (ch === '<' && contentText[i + 1] !== '<') {
      const end = contentText.indexOf('>', i + 1);
      if (end === -1) break;
      const hex = contentText.slice(i + 1, end);
      operandStack.push({ type: 'bytes', value: decodeHexTokenBytes(hex) });
      i = end + 1;
      continue;
    }

    // Array [...]
    if (ch === '[') {
      const items = [];
      i += 1;
      while (i < len && contentText[i] !== ']') {
        const c = contentText[i];
        if (/\s/.test(c)) {
          i += 1;
          continue;
        }
        if (c === '(') {
          let depth = 0;
          let escaped = false;
          const start = i + 1;
          for (; i < len; i += 1) {
            const sc = contentText[i];
            if (escaped) {
              escaped = false;
              continue;
            }
            if (sc === '\\') {
              escaped = true;
              continue;
            }
            if (sc === '(') depth += 1;
            else if (sc === ')') {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          items.push({ type: 'bytes', value: decodePdfLiteralString(contentText.slice(start, i)) });
          i += 1;
          continue;
        }
        if (c === '<' && contentText[i + 1] !== '<') {
          const end = contentText.indexOf('>', i + 1);
          if (end === -1) break;
          items.push({ type: 'bytes', value: decodeHexTokenBytes(contentText.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
        const numMatch = contentText.slice(i).match(/^[+-]?(?:\d+\.?\d*|\.\d+)/);
        if (numMatch) {
          items.push({ type: 'num', value: Number(numMatch[0]) });
          i += numMatch[0].length;
          continue;
        }
        i += 1;
      }
      operandStack.push({ type: 'array', value: items });
      i += 1;
      continue;
    }

    // Name /FontName
    if (ch === '/') {
      const nameMatch = contentText.slice(i).match(/^\/([^\s/<>\[\]()%]+)/);
      if (nameMatch) {
        operandStack.push({ type: 'name', value: nameMatch[1] });
        i += nameMatch[0].length;
        continue;
      }
    }

    // Operator or number
    const wordMatch = contentText.slice(i).match(/^[^\s/<>\[\]()%]+/);
    if (!wordMatch) {
      i += 1;
      continue;
    }
    const token = wordMatch[0];
    i += token.length;

    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      operandStack.push({ type: 'num', value: Number(token) });
      continue;
    }

    const cmap = currentFont ? fontCmaps.get(currentFont) : null;

    switch (token) {
      case 'BT':
        operandStack.length = 0;
        break;
      case 'ET':
        flushLine();
        operandStack.length = 0;
        break;
      case 'Tf': {
        const fontOperand = operandStack.length >= 2 ? operandStack[operandStack.length - 2] : null;
        if (fontOperand?.type === 'name') {
          currentFont = fontOperand.value;
        }
        operandStack.length = 0;
        break;
      }
      case 'Tj': {
        const op = operandStack.pop();
        if (op?.type === 'bytes') {
          currentLine += decodeBytesWithFont(op.value, cmap);
        }
        operandStack.length = 0;
        break;
      }
      case 'TJ': {
        const op = operandStack.pop();
        if (op?.type === 'array') {
          for (const item of op.value) {
            if (item.type === 'bytes') {
              currentLine += decodeBytesWithFont(item.value, cmap);
            } else if (item.type === 'num' && item.value < -130) {
              if (currentLine && !currentLine.endsWith(' ')) {
                currentLine += ' ';
              }
            }
          }
        }
        operandStack.length = 0;
        break;
      }
      case "'":
      case '"': {
        const op = operandStack.pop();
        flushLine();
        if (op?.type === 'bytes') {
          currentLine += decodeBytesWithFont(op.value, cmap);
        }
        operandStack.length = 0;
        break;
      }
      case 'T*':
        flushLine();
        operandStack.length = 0;
        break;
      case 'Td':
      case 'TD': {
        const ty = operandStack.length >= 1 ? operandStack[operandStack.length - 1] : null;
        if (ty?.type === 'num' && Math.abs(ty.value) > 0.5) {
          flushLine();
        }
        operandStack.length = 0;
        break;
      }
      case 'Tm': {
        if (currentLine.trim()) flushLine();
        operandStack.length = 0;
        break;
      }
      default:
        operandStack.length = 0;
        break;
    }
  }

  flushLine();
  return lines.join('\n');
}

function collectPagesInOrder(objects) {
  const ordered = [];
  const visited = new Set();

  // Find Catalog -> /Pages
  let rootPagesKey = null;
  for (const [, obj] of objects) {
    if (/\/Type\s*\/Catalog\b/.test(obj.dictText)) {
      rootPagesKey = parseRefKey(extractDictEntry(obj.dictText, 'Pages'));
      break;
    }
  }

  const walkPagesNode = (key, inheritedResources) => {
    if (!key || visited.has(key)) return;
    visited.add(key);
    const obj = objects.get(key);
    if (!obj) return;

    const ownResources = extractDictEntry(obj.dictText, 'Resources') || inheritedResources;

    if (/\/Type\s*\/Pages\b/.test(obj.dictText)) {
      const kids = parseAllRefs(extractDictEntry(obj.dictText, 'Kids'));
      for (const kidKey of kids) {
        walkPagesNode(kidKey, ownResources);
      }
      return;
    }

    if (/\/Type\s*\/Page\b/.test(obj.dictText)) {
      ordered.push({ obj, resourcesToken: ownResources });
    }
  };

  if (rootPagesKey) {
    walkPagesNode(rootPagesKey, '');
  }

  if (ordered.length === 0) {
    for (const [, obj] of objects) {
      if (/\/Type\s*\/Page\b(?!s)/.test(obj.dictText)) {
        ordered.push({ obj, resourcesToken: extractDictEntry(obj.dictText, 'Resources') });
      }
    }
  }

  return ordered;
}

async function resolvePageFonts(objects, resourcesToken, cmapCache) {
  const fontCmaps = new Map();
  let resDict = resourcesToken || '';
  const resRefKey = parseRefKey(resDict);
  if (resRefKey && objects.has(resRefKey)) {
    resDict = objects.get(resRefKey).dictText;
  }
  if (!resDict) return fontCmaps;

  let fontEntry = extractDictEntry(resDict, 'Font');
  const fontDictRefKey = parseRefKey(fontEntry);
  if (fontDictRefKey && objects.has(fontDictRefKey)) {
    fontEntry = objects.get(fontDictRefKey).dictText;
  }
  if (!fontEntry) return fontCmaps;

  const fontPairRe = /\/([^\s/<>\[\]()]+)\s+(\d+\s+\d+\s+R)/g;
  let match;
  while ((match = fontPairRe.exec(fontEntry)) !== null) {
    const fontName = match[1];
    const fontKey = parseRefKey(match[2]);
    const fontObj = fontKey ? objects.get(fontKey) : null;
    if (!fontObj) continue;

    const toUnicodeKey = parseRefKey(extractDictEntry(fontObj.dictText, 'ToUnicode'));
    if (!toUnicodeKey || !objects.has(toUnicodeKey)) continue;

    if (!cmapCache.has(toUnicodeKey)) {
      const cmapText = await getDecodedStreamText(objects.get(toUnicodeKey));
      cmapCache.set(toUnicodeKey, parseToUnicodeCMap(cmapText));
    }
    fontCmaps.set(fontName, cmapCache.get(toUnicodeKey));
  }

  return fontCmaps;
}

function extractTitleFromObjects(objects) {
  for (const [, obj] of objects) {
    if (!obj.dictText) continue;
    if (/\/Producer\b|\/Creator\b|\/CreationDate\b|\/Title\b/.test(obj.dictText)) {
      const titleToken = extractDictEntry(obj.dictText, 'Title');
      if (titleToken.startsWith('(') && titleToken.endsWith(')')) {
        const decoded = decodeBytesWithFont(decodePdfLiteralString(titleToken.slice(1, -1)), null).trim();
        if (decoded) return decoded;
      } else if (titleToken.startsWith('<') && titleToken.endsWith('>')) {
        const decoded = decodeBytesWithFont(decodeHexTokenBytes(titleToken.slice(1, -1)), null).trim();
        if (decoded) return decoded;
      }
    }
  }
  return '';
}

/**
 * Parse a PDF byte buffer into metadata and per-page extracted text.
 */
export async function parsePdfBytes(inputBytes) {
  const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  if (bytes.length < 8) {
    throw new Error('有効な PDF ファイルではありません（サイズが小さすぎます）。');
  }

  const headerSample = bytesToLatin1(bytes.subarray(0, 64));
  const pdfHeaderMatch = headerSample.match(/%PDF-(\d+\.\d+)/);
  if (!pdfHeaderMatch) {
    throw new Error('有効な PDF ヘッダ (%PDF-) が見つかりませんでした。');
  }

  const version = pdfHeaderMatch[1];
  const latin1 = bytesToLatin1(bytes);
  const objects = parseIndirectObjects(latin1);
  const orderedPages = collectPagesInOrder(objects);
  const cmapCache = new Map();

  const pages = [];
  for (let i = 0; i < orderedPages.length; i += 1) {
    const { obj: pageObj, resourcesToken } = orderedPages[i];
    const fontCmaps = await resolvePageFonts(objects, resourcesToken, cmapCache);

    const contentsToken = extractDictEntry(pageObj.dictText, 'Contents');
    const contentRefs = parseAllRefs(contentsToken);

    let combinedContent = '';
    for (const refKey of contentRefs) {
      const contentObj = objects.get(refKey);
      if (contentObj) {
        const decoded = await getDecodedStreamText(contentObj);
        combinedContent += `${decoded}\n`;
      }
    }

    const text = combinedContent ? extractTextFromContentStream(combinedContent, fontCmaps) : '';
    pages.push({
      pageNumber: i + 1,
      text: text.trim()
    });
  }

  const fullText = pages
    .map((p) => (p.text ? `[Page ${p.pageNumber}]\n${p.text}` : ''))
    .filter(Boolean)
    .join('\n\n');

  return {
    version,
    pageCount: pages.length,
    title: extractTitleFromObjects(objects),
    byteLength: bytes.length,
    pages,
    fullText,
    hasExtractableText: pages.some((p) => p.text.length > 0)
  };
}

/**
 * Extract a page snippet bounded to `maxChars` for Gemini Nano's context window.
 */
export function extractPdfPageSnippet(parsedPdf, pageNumber = 1, maxChars = 2000) {
  if (!parsedPdf || !Array.isArray(parsedPdf.pages) || parsedPdf.pages.length === 0) {
    return { pageNumber: 1, totalPages: 0, text: '', truncated: false };
  }
  const safePage = Math.max(1, Math.min(parsedPdf.pages.length, Number(pageNumber) || 1));
  const raw = parsedPdf.pages[safePage - 1]?.text || '';
  const truncated = raw.length > maxChars;
  return {
    pageNumber: safePage,
    totalPages: parsedPdf.pages.length,
    text: truncated ? `${raw.slice(0, maxChars - 1)}…` : raw,
    truncated
  };
}
