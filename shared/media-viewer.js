export const VIEWER_SUPPORTED_EXTENSIONS = Object.freeze({
  jpg: { category: 'image', label: 'JPEG画像', mimeType: 'image/jpeg' },
  jpeg: { category: 'image', label: 'JPEG画像', mimeType: 'image/jpeg' },
  jpe: { category: 'image', label: 'JPEG画像', mimeType: 'image/jpeg' },
  jfif: { category: 'image', label: 'JPEG (JFIF)画像', mimeType: 'image/jpeg' },
  pjpeg: { category: 'image', label: 'JPEG画像', mimeType: 'image/jpeg' },
  pjp: { category: 'image', label: 'JPEG画像', mimeType: 'image/jpeg' },
  png: { category: 'image', label: 'PNG画像', mimeType: 'image/png' },
  bmp: { category: 'image', label: 'BMP画像', mimeType: 'image/bmp' },
  dib: { category: 'image', label: 'BMP画像', mimeType: 'image/bmp' },
  webp: { category: 'image', label: 'WebP画像', mimeType: 'image/webp' },
  gif: { category: 'image', label: 'GIF画像', mimeType: 'image/gif' },
  ai: { category: 'illustrator', label: 'Adobe Illustrator (.ai)', mimeType: 'application/illustrator' },
  mp4: { category: 'video', label: 'MP4動画', mimeType: 'video/mp4' },
  m4v: { category: 'video', label: 'MP4動画', mimeType: 'video/mp4' },
  mov: { category: 'video', label: 'QuickTime (MOV)動画', mimeType: 'video/quicktime' },
  qt: { category: 'video', label: 'QuickTime (MOV)動画', mimeType: 'video/quicktime' },
  pdf: { category: 'document', label: 'PDF文書', mimeType: 'application/pdf' }
});

const MIME_TO_SPEC = Object.freeze({
  'image/jpeg': { ext: 'jpg', ...VIEWER_SUPPORTED_EXTENSIONS.jpg },
  'image/pjpeg': { ext: 'jpg', ...VIEWER_SUPPORTED_EXTENSIONS.jpg },
  'image/png': { ext: 'png', ...VIEWER_SUPPORTED_EXTENSIONS.png },
  'image/bmp': { ext: 'bmp', ...VIEWER_SUPPORTED_EXTENSIONS.bmp },
  'image/x-ms-bmp': { ext: 'bmp', ...VIEWER_SUPPORTED_EXTENSIONS.bmp },
  'image/webp': { ext: 'webp', ...VIEWER_SUPPORTED_EXTENSIONS.webp },
  'image/gif': { ext: 'gif', ...VIEWER_SUPPORTED_EXTENSIONS.gif },
  'application/postscript': { ext: 'ai', ...VIEWER_SUPPORTED_EXTENSIONS.ai },
  'application/illustrator': { ext: 'ai', ...VIEWER_SUPPORTED_EXTENSIONS.ai },
  'video/mp4': { ext: 'mp4', ...VIEWER_SUPPORTED_EXTENSIONS.mp4 },
  'video/quicktime': { ext: 'mov', ...VIEWER_SUPPORTED_EXTENSIONS.mov },
  'application/pdf': { ext: 'pdf', ...VIEWER_SUPPORTED_EXTENSIONS.pdf }
});

function extractTailExtension(pathLike = '') {
  const clean = String(pathLike || '').split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function extractExtensionFromUrlOrName(urlOrName = '') {
  const raw = String(urlOrName || '').trim();
  if (!raw) return '';

  try {
    if (/^(https?|blob):/i.test(raw)) {
      const parsed = new URL(raw.startsWith('blob:') ? raw.slice(5) : raw);
      const pathExt = extractTailExtension(decodeURIComponent(parsed.pathname || ''));
      if (pathExt && VIEWER_SUPPORTED_EXTENSIONS[pathExt]) {
        return pathExt;
      }
      for (const param of ['filename', 'file', 'name', 'download']) {
        const val = parsed.searchParams.get(param);
        if (val) {
          const qExt = extractTailExtension(val);
          if (qExt && VIEWER_SUPPORTED_EXTENSIONS[qExt]) {
            return qExt;
          }
        }
      }
      return pathExt;
    }
  } catch {
    // Fall back to string suffix inspection
  }

  return extractTailExtension(raw);
}

export function classifyViewerMedia({ url = '', filename = '', mimeType = '' } = {}) {
  const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const extFromName = extractExtensionFromUrlOrName(filename);
  const extFromUrl = extractExtensionFromUrlOrName(url);
  const ext = VIEWER_SUPPORTED_EXTENSIONS[extFromName]
    ? extFromName
    : VIEWER_SUPPORTED_EXTENSIONS[extFromUrl]
      ? extFromUrl
      : '';

  if (ext && VIEWER_SUPPORTED_EXTENSIONS[ext]) {
    const spec = VIEWER_SUPPORTED_EXTENSIONS[ext];
    // For .ai downloaded or served with application/pdf, preserve illustrator category when filename/url says .ai
    return {
      supported: true,
      ext,
      category: spec.category,
      label: spec.label,
      mimeType: spec.mimeType
    };
  }

  if (normalizedMime && MIME_TO_SPEC[normalizedMime]) {
    const spec = MIME_TO_SPEC[normalizedMime];
    return {
      supported: true,
      ext: spec.ext,
      category: spec.category,
      label: spec.label,
      mimeType: spec.mimeType
    };
  }

  return {
    supported: false,
    ext: extFromName || extFromUrl || '',
    category: 'unknown',
    label: '非対応形式',
    mimeType: normalizedMime || 'application/octet-stream'
  };
}

export function isSupportedViewerUrl(url = '', filename = '', mimeType = '') {
  return classifyViewerMedia({ url, filename, mimeType }).supported;
}

function readAscii(bytes, offset, length) {
  let out = '';
  const end = Math.min(bytes.length, offset + length);
  for (let i = offset; i < end; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function readUint32BE(bytes, offset) {
  if (offset + 4 > bytes.length) return 0;
  return (
    ((bytes[offset] << 24) >>> 0) +
    ((bytes[offset + 1] << 16) >>> 0) +
    ((bytes[offset + 2] << 8) >>> 0) +
    (bytes[offset + 3] >>> 0)
  );
}

function findAsciiSequence(bytes, pattern, maxScan = bytes.length) {
  const limit = Math.min(bytes.length, maxScan) - pattern.length;
  for (let i = 0; i <= limit; i += 1) {
    let match = true;
    for (let j = 0; j < pattern.length; j += 1) {
      if (bytes[i + j] !== pattern.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

export function detectMagicMimeType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) {
    return '';
  }

  // PDF (%PDF-)
  if (findAsciiSequence(bytes, '%PDF-', 1024) !== -1) {
    // Could be .pdf or PDF-compatible .ai; caller merges extension classification
    return 'application/pdf';
  }

  // JPEG (FF D8 FF)
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG (89 50 4E 47 0D 0A 1A 0A)
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }

  // GIF (GIF87a / GIF89a)
  const head6 = readAscii(bytes, 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return 'image/gif';
  }

  // BMP (BM)
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }

  // WebP (RIFF....WEBP)
  if (bytes.length >= 12 && readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WEBP') {
    return 'image/webp';
  }

  // ISO BMFF Video (ftyp)
  if (bytes.length >= 12 && readAscii(bytes, 4, 4) === 'ftyp') {
    const brand = readAscii(bytes, 8, 4);
    if (brand === 'qt  ') {
      return 'video/quicktime';
    }
    return 'video/mp4';
  }

  // PostScript / DOS EPS (.ai legacy)
  if (readAscii(bytes, 0, 4) === '%!PS' || (bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6)) {
    return 'application/postscript';
  }

  return '';
}

export function inspectIllustratorBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return {
      format: 'unknown',
      isPdfCompatible: false,
      pdfOffset: -1,
      metadata: {},
      extractedText: ''
    };
  }

  const pdfOffset = findAsciiSequence(bytes, '%PDF-', 1024);
  if (pdfOffset !== -1) {
    return {
      format: 'pdf-compatible',
      isPdfCompatible: true,
      pdfOffset,
      metadata: {},
      extractedText: ''
    };
  }

  // Legacy PostScript or DOS binary EPS header
  let psStart = 0;
  let psLength = Math.min(bytes.length, 262144);
  if (bytes.length >= 30 && bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6) {
    const epsOffset = bytes[4] + (bytes[5] << 8) + (bytes[6] << 16) + ((bytes[7] << 24) >>> 0);
    const epsLen = bytes[8] + (bytes[9] << 8) + (bytes[10] << 16) + ((bytes[11] << 24) >>> 0);
    if (epsOffset > 0 && epsOffset < bytes.length) {
      psStart = epsOffset;
      psLength = epsLen > 0 ? Math.min(epsLen, bytes.length - psStart, 262144) : Math.min(bytes.length - psStart, 262144);
    }
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const textSlice = decoder.decode(bytes.subarray(psStart, psStart + psLength));
  const metadata = {};
  for (const line of textSlice.split(/\r?\n/).slice(0, 120)) {
    const m = line.match(/^%%(Title|Creator|CreationDate|BoundingBox|DocumentProcessColors):\s*(.+)$/i);
    if (m) {
      metadata[m[1]] = m[2].trim();
    }
  }

  const literalStrings = [];
  const strRe = /\(([^()\r\n]{2,100})\)/g;
  let match;
  while ((match = strRe.exec(textSlice)) !== null && literalStrings.length < 80) {
    const candidate = match[1].replace(/\\([()\\])/g, '$1').trim();
    if (candidate && /[A-Za-z0-9\u3040-\u30ff\u4e00-\u9faf]/.test(candidate)) {
      if (!literalStrings.includes(candidate)) {
        literalStrings.push(candidate);
      }
    }
  }

  const metaLines = Object.entries(metadata).map(([k, v]) => `${k}: ${v}`);
  const extractedText = [
    '【Adobe Illustrator PostScript / EPS 形式】',
    '※ PDF 互換ストリームを含まない古い形式の .ai ファイルのため、メタデータと抽出テキストを表示しています。',
    metaLines.length > 0 ? `\n[メタデータ]\n${metaLines.join('\n')}` : '',
    literalStrings.length > 0 ? `\n[抽出されたテキスト候補]\n${literalStrings.join(' / ')}` : ''
  ]
    .filter(Boolean)
    .join('\n');

  return {
    format: 'postscript',
    isPdfCompatible: false,
    pdfOffset: -1,
    metadata,
    extractedText
  };
}

export function inspectVideoContainerBytes(bytes, hintMimeType = '') {
  let majorBrand = '';
  if (bytes instanceof Uint8Array && bytes.length >= 12 && readAscii(bytes, 4, 4) === 'ftyp') {
    majorBrand = readAscii(bytes, 8, 4);
  }

  const scanLimit = bytes instanceof Uint8Array ? Math.min(bytes.length, 262144) : 0;
  let videoCodec = '不明';
  let audioCodec = 'なし/不明';

  if (scanLimit > 0) {
    const checkFourCC = (cc) => findAsciiSequence(bytes, cc, scanLimit) !== -1;

    if (checkFourCC('hvc1') || checkFourCC('hev1')) {
      videoCodec = 'H.265 (HEVC)';
    } else if (checkFourCC('avc1') || checkFourCC('avc3')) {
      videoCodec = 'H.264 (AVC)';
    } else if (checkFourCC('av01')) {
      videoCodec = 'AV1';
    } else if (checkFourCC('vp09')) {
      videoCodec = 'VP9';
    } else if (checkFourCC('mp4v')) {
      videoCodec = 'MPEG-4 Visual';
    } else if (checkFourCC('apch') || checkFourCC('apcn') || checkFourCC('apcs')) {
      videoCodec = 'Apple ProRes';
    }

    if (checkFourCC('mp4a')) {
      audioCodec = 'AAC';
    } else if (checkFourCC('alac')) {
      audioCodec = 'ALAC';
    } else if (checkFourCC('ac-3') || checkFourCC('ec-3')) {
      audioCodec = 'Dolby Digital (AC-3/E-AC-3)';
    } else if (checkFourCC('Opus')) {
      audioCodec = 'Opus';
    } else if (checkFourCC('sowt') || checkFourCC('lpcm')) {
      audioCodec = 'PCM';
    }
  }

  const isQuickTime = majorBrand === 'qt  ' || hintMimeType === 'video/quicktime';
  const container = isQuickTime ? 'QuickTime (MOV)' : 'MP4';
  const preferredMimeType = isQuickTime ? 'video/quicktime' : 'video/mp4';
  const fallbackMimeType = isQuickTime ? 'video/mp4' : 'video/quicktime';

  return {
    container,
    majorBrand: majorBrand || '(unknown)',
    videoCodec,
    audioCodec,
    preferredMimeType,
    fallbackMimeType,
    boxSize: bytes instanceof Uint8Array && bytes.length >= 4 ? readUint32BE(bytes, 0) : 0
  };
}
