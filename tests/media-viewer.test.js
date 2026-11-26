import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyViewerMedia,
  detectMagicMimeType,
  extractExtensionFromUrlOrName,
  inspectIllustratorBytes,
  inspectVideoContainerBytes,
  isSupportedViewerUrl
} from '../shared/media-viewer.js';

test('classifyViewerMedia accepts all requested image, video, illustrator, and pdf formats', () => {
  const cases = [
    ['photo.jpg', 'image'],
    ['photo.jpeg', 'image'],
    ['photo.jfif', 'image'],
    ['photo.pjpeg', 'image'],
    ['photo.pjp', 'image'],
    ['diagram.png', 'image'],
    ['bitmap.bmp', 'image'],
    ['design.ai', 'illustrator'],
    ['anim.webp', 'image'],
    ['clip.gif', 'image'],
    ['movie.mp4', 'video'],
    ['clip.mov', 'video'],
    ['manual.pdf', 'document']
  ];

  for (const [name, expectedCategory] of cases) {
    const res = classifyViewerMedia({ url: `https://example.com/files/${name}?dl=1`, filename: name });
    assert.equal(res.supported, true, `Expected ${name} to be supported`);
    assert.equal(res.category, expectedCategory, `Unexpected category for ${name}`);
    assert.equal(isSupportedViewerUrl(`https://example.com/files/${name}?dl=1`), true);
  }

  for (const unsupported of ['index.html', 'archive.zip', 'document.docx', 'script.js']) {
    const res = classifyViewerMedia({ url: `https://example.com/${unsupported}` });
    assert.equal(res.supported, false, `Expected ${unsupported} not to be intercepted`);
  }
});

test('extractExtensionFromUrlOrName handles URL-encoded paths and query parameters', () => {
  assert.equal(
    extractExtensionFromUrlOrName('https://example.com/download?id=12&filename=%E8%B3%87%E6%96%99.PDF'),
    'pdf'
  );
  assert.equal(
    extractExtensionFromUrlOrName('https://cdn.example.com/assets/logo%20v2.ai#page=1'),
    'ai'
  );
  assert.equal(extractExtensionFromUrlOrName('blob:https://example.com/123?file=preview.mov'), 'mov');
});

test('detectMagicMimeType identifies binary signatures accurately', () => {
  const enc = new TextEncoder();
  assert.equal(detectMagicMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(detectMagicMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  assert.equal(detectMagicMimeType(enc.encode('GIF89a...')), 'image/gif');
  assert.equal(detectMagicMimeType(new Uint8Array([0x42, 0x4d, 0x10, 0x00])), 'image/bmp');
  assert.equal(detectMagicMimeType(enc.encode('RIFF\x00\x00\x00\x00WEBP')), 'image/webp');
  assert.equal(detectMagicMimeType(enc.encode('%PDF-1.7\n')), 'application/pdf');
  assert.equal(detectMagicMimeType(enc.encode('%!PS-Adobe-3.0\n')), 'application/postscript');
  assert.equal(detectMagicMimeType(enc.encode('\x00\x00\x00\x14ftypisom')), 'video/mp4');
  assert.equal(detectMagicMimeType(enc.encode('\x00\x00\x00\x14ftypqt  ')), 'video/quicktime');
});

test('inspectIllustratorBytes handles PDF-compatible .ai and legacy PostScript .ai files', () => {
  const enc = new TextEncoder();
  const pdfCompatBytes = enc.encode('  %PDF-1.5\n1 0 obj\n<<>>\nendobj');
  const compatRes = inspectIllustratorBytes(pdfCompatBytes);
  assert.equal(compatRes.isPdfCompatible, true);
  assert.equal(compatRes.format, 'pdf-compatible');
  assert.equal(compatRes.pdfOffset, 2);

  const psBytes = enc.encode(
    '%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator\n%%Title: Sample Banner\n%%BoundingBox: 0 0 800 600\n(Campaign Logo) Tj\n'
  );
  const psRes = inspectIllustratorBytes(psBytes);
  assert.equal(psRes.isPdfCompatible, false);
  assert.equal(psRes.format, 'postscript');
  assert.equal(psRes.metadata.Title, 'Sample Banner');
  assert.match(psRes.extractedText, /Campaign Logo/);
});

test('inspectVideoContainerBytes identifies H.264, H.265 (HEVC), and QuickTime MOV containers', () => {
  const enc = new TextEncoder();
  const h264Mp4 = enc.encode('\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom....avc1....mp4a');
  const r1 = inspectVideoContainerBytes(h264Mp4, 'video/mp4');
  assert.equal(r1.container, 'MP4');
  assert.equal(r1.videoCodec, 'H.264 (AVC)');
  assert.equal(r1.audioCodec, 'AAC');
  assert.equal(r1.preferredMimeType, 'video/mp4');

  const hevcMp4 = enc.encode('\x00\x00\x00\x18ftypisom....hvc1....mp4a');
  const r2 = inspectVideoContainerBytes(hevcMp4, 'video/mp4');
  assert.equal(r2.videoCodec, 'H.265 (HEVC)');

  const movQt = enc.encode('\x00\x00\x00\x18ftypqt  ....hev1');
  const r3 = inspectVideoContainerBytes(movQt, 'video/quicktime');
  assert.equal(r3.container, 'QuickTime (MOV)');
  assert.equal(r3.videoCodec, 'H.265 (HEVC)');
  assert.equal(r3.preferredMimeType, 'video/quicktime');
  assert.equal(r3.fallbackMimeType, 'video/mp4');
});
