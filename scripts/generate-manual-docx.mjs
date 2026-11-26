import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMG_DIR = resolve(__dirname, '../docs/manual-images');
const OUTPUT_PATH = resolve(__dirname, '../docs/Gemini-Nano-Computer-Use-Manual.docx');

// --- Minimal Pure-Node ZIP (DEFLATE) Builder ---

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressedBuf = entry.store ? rawBuf : deflateRawSync(rawBuf);
    const method = entry.store ? 0 : 8;
    const crc = crc32(rawBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x5421, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuf, compressedBuf);

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0x0800, 8);
    cdHeader.writeUInt16LE(method, 10);
    cdHeader.writeUInt16LE(0, 12);
    cdHeader.writeUInt16LE(0x5421, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(compressedBuf.length, 20);
    cdHeader.writeUInt32LE(rawBuf.length, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(0, 38);
    cdHeader.writeUInt32LE(offset, 42);

    centralChunks.push(cdHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressedBuf.length;
  }

  const centralSize = centralChunks.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

// --- PNG & DrawingML Helpers ---

function readPngDimensions(buf) {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('有効な PNG 画像ではありません。');
  }
  return {
    widthPx: buf.readUInt32BE(16),
    heightPx: buf.readUInt32BE(20)
  };
}

const IMAGES_META = [
  {
    rId: 'rId10',
    zipPath: 'word/media/img01.png',
    file: '01-sidepanel-main.png',
    caption: '図1: いつもの操作画面（サイドパネル「AI 操作」タブ）',
    maxWidthCm: 8.6,
    maxHeightCm: 14.2
  },
  {
    rId: 'rId11',
    zipPath: 'word/media/img02.png',
    file: '02-sidepanel-playbook.png',
    caption: '図2: 「詳細設定」を開いた画面と、手順書のアップロード／変換スキル画面',
    maxWidthCm: 7.4,
    maxHeightCm: 16.5
  },
  {
    rId: 'rId12',
    zipPath: 'word/media/img03.png',
    file: '03-sidepanel-confirm-log.png',
    caption: '図3: AI が作業しているときの画面（確認カード・タブ整理・作業記録）',
    maxWidthCm: 7.4,
    maxHeightCm: 16.5
  },
  {
    rId: 'rId13',
    zipPath: 'word/media/img04.png',
    file: '04-sidepanel-flow-tab.png',
    caption: '図4: 「フロー設計」タブ（保存した作業の呼び出し・ワンクリック実行）',
    maxWidthCm: 8.6,
    maxHeightCm: 14.2
  },
  {
    rId: 'rId14',
    zipPath: 'word/media/img05.png',
    file: '05-studio-editor.png',
    caption: '図5: 専用フロー設計画面（ブロックとつなぎ線で作業手順を作る画面）',
    maxWidthCm: 16.2,
    maxHeightCm: 11.0
  },
  {
    rId: 'rId15',
    zipPath: 'word/media/img06.png',
    file: '06-media-viewer.png',
    caption: '図6: 簡易ビュワー画面（画像・動画・PDF・Illustrator ファイルを別タブで表示）',
    maxWidthCm: 15.8,
    maxHeightCm: 10.6
  }
].map((meta, idx) => {
  const bytes = readFileSync(resolve(IMG_DIR, meta.file));
  const { widthPx, heightPx } = readPngDimensions(bytes);
  return { ...meta, docPrId: idx + 1, bytes, widthPx, heightPx };
});

function makeImageBlock(imgMeta) {
  const EMU_PER_CM = 360000;
  const maxW = imgMeta.maxWidthCm * EMU_PER_CM;
  const maxH = imgMeta.maxHeightCm * EMU_PER_CM;
  const ratio = imgMeta.heightPx / imgMeta.widthPx;

  let cx = maxW;
  let cy = Math.round(cx * ratio);
  if (cy > maxH) {
    cy = maxH;
    cx = Math.round(cy / ratio);
  }

  return `<w:p>
    <w:pPr><w:keepNext/><w:spacing w:before="100" w:after="60"/><w:jc w:val="center"/></w:pPr>
    <w:r>
      <w:drawing>
        <wp:inline distT="0" distB="0" distL="0" distR="0">
          <wp:extent cx="${cx}" cy="${cy}"/>
          <wp:effectExtent l="0" t="0" r="0" b="0"/>
          <wp:docPr id="${imgMeta.docPrId}" name="Picture ${imgMeta.docPrId}" descr="${esc(imgMeta.caption)}"/>
          <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
          <a:graphic>
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:pic>
                <pic:nvPicPr>
                  <pic:cNvPr id="${imgMeta.docPrId}" name="${esc(imgMeta.file)}"/>
                  <pic:cNvPicPr/>
                </pic:nvPicPr>
                <pic:blipFill>
                  <a:blip r:embed="${imgMeta.rId}"/>
                  <a:stretch><a:fillRect/></a:stretch>
                </pic:blipFill>
                <pic:spPr>
                  <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
                  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                  <a:ln w="9525"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:ln>
                </pic:spPr>
              </pic:pic>
            </a:graphicData>
          </a:graphic>
        </wp:inline>
      </w:drawing>
    </w:r>
  </w:p>
  <w:p>
    <w:pPr><w:spacing w:before="0" w:after="140"/><w:jc w:val="center"/></w:pPr>
    ${makeRun(imgMeta.caption, { bold: true, color: '475569', sizeHalfPt: 18 })}
  </w:p>`;
}

// --- OOXML Document Text & Table Helpers ---

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function makeRun(text, { bold = false, color = null, sizeHalfPt = null, code = false } = {}) {
  const fontName = code ? 'Consolas' : 'Meiryo UI';
  const rPrParts = [`<w:rFonts w:ascii="${fontName}" w:hAnsi="${fontName}" w:eastAsia="Meiryo UI"/>`];
  if (bold) rPrParts.push('<w:b/>');
  if (color) rPrParts.push(`<w:color w:val="${color}"/>`);
  if (sizeHalfPt) {
    rPrParts.push(`<w:sz w:val="${sizeHalfPt}"/><w:szCs w:val="${sizeHalfPt}"/>`);
  }
  if (code) {
    rPrParts.push('<w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/>');
  }
  return `<w:r><w:rPr>${rPrParts.join('')}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function makeRichRuns(text, baseOpts = {}) {
  const src = String(text ?? '');
  const parts = src.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts
    .map((part) => {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        return makeRun(part.slice(2, -2), { ...baseOpts, bold: true });
      }
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        return makeRun(part.slice(1, -1), { ...baseOpts, code: true });
      }
      return makeRun(part, baseOpts);
    })
    .join('');
}

function p(
  text,
  { spaceBefore = 0, spaceAfter = 100, line = 300, align = 'left', style = null, color = null, sizeHalfPt = null, bold = false } = {}
) {
  const pPr = [];
  if (style) pPr.push(`<w:pStyle w:val="${style}"/>`);
  pPr.push(`<w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}" w:line="${line}" w:lineRule="auto"/>`);
  if (align !== 'left') pPr.push(`<w:jc w:val="${align}"/>`);
  return `<w:p><w:pPr>${pPr.join('')}</w:pPr>${makeRichRuns(text, { color, sizeHalfPt, bold })}</w:p>`;
}

function h1(text, { pageBreakBefore = false } = {}) {
  const pb = pageBreakBefore ? '<w:pageBreakBefore/>' : '';
  return `<w:p><w:pPr><w:pStyle w:val="Heading1"/>${pb}<w:shd w:val="clear" w:color="auto" w:fill="EFF6FF"/><w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="2563EB"/><w:bottom w:val="single" w:sz="6" w:space="4" w:color="BFDBFE"/></w:pBdr></w:pPr>${makeRun(text, { bold: true, color: '1E3A8A', sizeHalfPt: 30 })}</w:p>`;
}

function h2(text) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading2"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="3" w:color="CBD5E1"/></w:pBdr></w:pPr>${makeRun(text, { bold: true, color: '1E40AF', sizeHalfPt: 24 })}</w:p>`;
}

function h3(text) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr>${makeRun(text, { bold: true, color: '0F172A', sizeHalfPt: 21 })}</w:p>`;
}

function bullets(items) {
  return items
    .map(
      (item) =>
        `<w:p><w:pPr><w:spacing w:before="20" w:after="60" w:line="280" w:lineRule="auto"/><w:ind w:left="420" w:hanging="220"/></w:pPr>${makeRun('•  ', { bold: true, color: '2563EB' })}${makeRichRuns(item)}</w:p>`
    )
    .join('');
}

function steps(items) {
  return items
    .map(
      (item, idx) =>
        `<w:p><w:pPr><w:spacing w:before="20" w:after="60" w:line="280" w:lineRule="auto"/><w:ind w:left="460" w:hanging="280"/></w:pPr>${makeRun(`${idx + 1}. `, { bold: true, color: '1E40AF' })}${makeRichRuns(item)}</w:p>`
    )
    .join('');
}

function makeCallout(title, lines, tone = 'info') {
  const palette =
    tone === 'warn'
      ? { border: 'D97706', fill: 'FFFBEB', titleColor: 'B45309' }
      : { border: '2563EB', fill: 'F0F9FF', titleColor: '1D4ED8' };

  const inner = [
    `<w:p><w:pPr><w:spacing w:before="0" w:after="60"/></w:pPr>${makeRun(title, { bold: true, color: palette.titleColor, sizeHalfPt: 20 })}</w:p>`,
    ...lines.map(
      (line) =>
        `<w:p><w:pPr><w:spacing w:before="0" w:after="40" w:line="270" w:lineRule="auto"/></w:pPr>${makeRichRuns(line, { sizeHalfPt: 19, color: '1E293B' })}</w:p>`
    )
  ].join('');

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="9638" w:type="dxa"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
        <w:left w:val="single" w:sz="24" w:space="0" w:color="${palette.border}"/>
        <w:bottom w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
        <w:right w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
      </w:tblBorders>
      <w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="180" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tblCellMar>
    </w:tblPr>
    <w:tblGrid><w:gridCol w:w="9638"/></w:tblGrid>
    <w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="9638" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${palette.fill}"/></w:tcPr>${inner}</w:tc></w:tr>
  </w:tbl>${p('', { spaceAfter: 80 })}`;
}

function makeTable(headers, rows, colWidths) {
  const totalW = colWidths.reduce((s, w) => s + w, 0);
  const grid = colWidths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');

  const headerCells = headers
    .map(
      (head, i) => `<w:tc>
        <w:tcPr><w:tcW w:w="${colWidths[i]}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="1E40AF"/><w:vAlign w:val="center"/></w:tcPr>
        <w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>${makeRun(head, { bold: true, color: 'FFFFFF', sizeHalfPt: 18 })}</w:p>
      </w:tc>`
    )
    .join('');

  const bodyRows = rows
    .map((row, rIdx) => {
      const fill = rIdx % 2 === 1 ? 'F8FAFC' : 'FFFFFF';
      const cells = row
        .map(
          (cell, cIdx) => `<w:tc>
            <w:tcPr><w:tcW w:w="${colWidths[cIdx]}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/><w:vAlign w:val="top"/></w:tcPr>
            <w:p><w:pPr><w:spacing w:before="20" w:after="20" w:line="260" w:lineRule="auto"/></w:pPr>${makeRichRuns(cell, { sizeHalfPt: 18 })}</w:p>
          </w:tc>`
        )
        .join('');
      return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells}</w:tr>`;
    })
    .join('');

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="${totalW}" w:type="dxa"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="8" w:space="0" w:color="CBD5E1"/>
        <w:left w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
        <w:bottom w:val="single" w:sz="8" w:space="0" w:color="CBD5E1"/>
        <w:right w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
      </w:tblBorders>
      <w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>
    </w:tblPr>
    <w:tblGrid>${grid}</w:tblGrid>
    <w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${headerCells}</w:tr>
    ${bodyRows}
  </w:tbl>${p('', { spaceAfter: 80 })}`;
}

function makeCoverBanner() {
  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="9638" w:type="dxa"/>
      <w:tblBorders><w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/></w:tblBorders>
      <w:tblCellMar><w:top w:w="340" w:type="dxa"/><w:left w:w="300" w:type="dxa"/><w:bottom w:w="340" w:type="dxa"/><w:right w:w="300" w:type="dxa"/></w:tblCellMar>
    </w:tblPr>
    <w:tblGrid><w:gridCol w:w="9638"/></w:tblGrid>
    <w:tr><w:tc>
      <w:tcPr><w:tcW w:w="9638" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="1E3A8A"/></w:tcPr>
      <w:p><w:pPr><w:spacing w:before="0" w:after="100"/></w:pPr>${makeRun('はじめてでも画面を見ながらすぐ使えるガイド', { bold: true, color: '93C5FD', sizeHalfPt: 20 })}</w:p>
      <w:p><w:pPr><w:spacing w:before="0" w:after="120"/></w:pPr>${makeRun('Gemini Nano Computer Use', { bold: true, color: 'FFFFFF', sizeHalfPt: 44 })}</w:p>
      <w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>${makeRun('図解つき 操作マニュアル（画面の見方・手順書の使い方・自動フロー作成）', { color: 'E0E7FF', sizeHalfPt: 22 })}</w:p>
    </w:tc></w:tr>
  </w:tbl>${p('', { spaceAfter: 140 })}`;
}

// --- Manual Content (Plain, Visual, Beginner-Friendly Japanese) ---

function buildManualBodyXml() {
  const parts = [];
  const [img1, img2, img3, img4, img5, img6] = IMAGES_META;

  // Cover & Introduction
  parts.push(makeCoverBanner());
  parts.push(
    p(
      'このマニュアルは、普段お使いの Google Chrome（グーグルクローム）上で、AI があなたに代わってボタンをクリックしたり文字を入力したりするお助けツール **「Gemini Nano Computer Use」** の使い方を、実際の画面写真と番号つきでわかりやすくまとめたガイドです。'
    )
  );
  parts.push(
    makeCallout(
      'AI の知識がなくても安心！3つのポイント',
      [
        '1. **パソコンの中だけで動くから安心**: 普段使っている Chrome の中に内蔵された AI を使うため、見ているページや業務手順書がインターネット上の外部会社へ送信されることはありません。',
        '2. **ふだんの言葉で頼める・手順書通りに動く**: 「このページを調べてまとめて」と日本語で入力するだけで動きます。決まった業務手順書（Word や Excel など）を読み込ませれば、その通りの順番で正確に作業します。',
        '3. **危ない操作の前に必ず止まって聞いてくれる**: パスワード入力・送信・購入・削除などの大事な操作や、画面が想定と違っていたときは、AI が勝手に進めず必ず確認画面を出して人間に相談します。'
      ],
      'info'
    )
  );

  parts.push(h2('全体の流れ（どうやって動くの？）'));
  parts.push(
    steps([
      '**画面を見る**: AI が開いているWebページや画像・PDFの内容を読み取ります。',
      '**次の一手を考える**: あなたが書いた目標や手順書を見比べながら、「次にどのボタンを押すべきか」を 1 つだけ考えます。',
      '**危なくないかチェックする**: 送信や削除など大事な操作なら「本当に進めていいですか？」と画面で確認します。',
      '**操作を実行する**: 問題なければクリックや入力を実行し、目的が終わるまでくり返します。'
    ])
  );

  // Chapter 1
  parts.push(h1('第1章 はじめに（最初の準備と起動のしかた）', { pageBreakBefore: true }));
  parts.push(p('はじめてお使いになるときだけ、Google Chrome の設定を 3 つオンにしてツールを追加します（所要時間：約3分）。'));

  parts.push(h2('1.1 Chrome の機能をオンにする（初回のみ）'));
  parts.push(
    steps([
      'Chrome の上のアドレス欄（URL が表示される場所）に、下の表の「開く場所」をコピーして貼り付け、Enter キーを押します。',
      'それぞれ右側の選択欄を **「おすすめの設定」** に変更し、画面右下に表示される青い再起動ボタン（Relaunch）で Chrome を再起動します。'
    ])
  );
  parts.push(
    makeTable(
      ['設定の名前', 'アドレス欄に貼り付ける文字', 'おすすめの設定', 'この設定でできるようになること'],
      [
        ['AI 基本機能', '`chrome://flags/#prompt-api-for-gemini-nano`', '**Enabled**', 'Chrome の中で AI が言葉を理解できるようになります'],
        ['画像を見る機能', '`chrome://flags/#prompt-api-for-gemini-nano-with-multimodal-input`', '**Enabled**', 'AI が画面の写真や手順書の画像を見て判断できるようになります'],
        ['AI の起動準備', '`chrome://flags/#optimization-guide-on-device-model`', '**Enabled BypassPerfRequirement**', 'パソコンへの AI データの保存を許可します']
      ],
      [1800, 3400, 2100, 2338]
    )
  );

  parts.push(h2('1.2 ツールを Chrome に読み込む'));
  parts.push(
    steps([
      'Chrome のアドレス欄に `chrome://extensions/` と入力して開きます。',
      '画面の右上にある **「デベロッパー モード」** のスイッチをオンにします。',
      '左上に出る **「パッケージ化されていない拡張機能を読み込む」** を押し、このツールのフォルダを選択します。',
      'Chrome 右上の拡張機能アイコン（パズルのピースのマークなど）から **「Gemini Nano Computer Use」** をクリックすると、画面右側に操作パネルが開きます。',
      '一番上の欄に **「モデルをダウンロード」** ボタンが出ている場合はクリックし、100% になって緑色の丸「利用可能です」になるまで少し待ちます。'
    ])
  );
  parts.push(
    makeCallout(
      '会社のネットワーク等でダウンロードできないときは',
      [
        'AI のデータは Chrome 本体が Google の公式配信サーバー（`update.googleapis.com` / `edgedl.me.gvt1.com` / `redirector.gvt1.com`）から自動でダウンロードします。',
        '進まない場合はアドレス欄に `chrome://components` と入力し、「Optimization Guide On Device Model」欄のアップデートボタンを押してみてください。また、パソコンの空き容量にゆとりがあるかもご確認ください。'
      ],
      'warn'
    )
  );

  // Chapter 2
  parts.push(h1('第2章 いつもの操作画面の見方と使い方', { pageBreakBefore: true }));
  parts.push(p('Chrome 右側に開くパネル（サイドパネル）の基本画面です。写真の中の赤い番号（①〜⑦）と下の表を見比べてお使いください。'));
  parts.push(makeImageBlock(img1));
  parts.push(
    makeTable(
      ['番号', 'ボタン・画面の場所', '押すと何ができる？ どう動く？'],
      [
        ['①', '`↻`（再確認ボタン）', 'AI が使える状態かもう一度調べます。その下の「設定ガイド」を押すと、第1章の `chrome://flags` の文字をワンクリックでコピーできます。'],
        ['②', '`AI 操作` / `フロー設計` タブ', '普段の「AI 操作」画面と、よく使う作業を図にして保存する「フロー設計」画面を切り替えます。'],
        ['③', '`プリセット` ＋ `呼出` ボタン', '第3章で作った「保存済みの作業パターン」を選び、**「呼出」** を押すだけでその作業をすぐ使えるようにセットします。'],
        ['④', '`AI に任せたい操作（目標）`', 'AI にやってほしいことを日本語で書きます（例：「社内ポータルを開いて今月の請求書を確認して」）。手順書を読み込んでいるときは空欄のままでも動かせます。'],
        ['⑤', '`詳細設定`（初期はすべて ON）', '普段は閉じたまま（`すべてON`）でお使いください。クリックして開くと、4つの便利設定を個別にオン／オフできます（次の図2で詳しく説明します）。'],
        ['⑥', '`実行開始` / `履歴クリア`', '青い **「実行開始」** を押すと AI が作業を始めます。**「履歴クリア」** は一番下の「実行ログ（作業記録）」を消してスッキリさせます。'],
        ['⑦', '`手順書（SOP）アップロード・テンプレート`', 'クリックすると開きます。会社の手順書ファイルを読み込ませたり、手順書のひな形をダウンロードしたりできます。']
      ],
      [800, 2700, 6138]
    )
  );
  parts.push(
    p(
      '※ **「実行モード」** では、通常は自動で進んで危ないときだけ止まる **「自動（危険操作のみ確認）」** と、1回動くたびに「次を進めていいですか？」と聞く **「ステップ実行（毎回確認）」** を選べます。**「最大ステップ」** は 1 回の作業で AI が動く最大回数（既定 15 回）です。'
    )
  );

  // Section 2.2 Playbook + Advanced settings
  parts.push(h2('2.2 詳細設定と「手順書（SOP）」の使い方', { spaceBefore: 100 }));
  parts.push(p('「詳細設定」と「手順書（SOP）アップロード・テンプレート」を開いた画面です。図の ①〜⑥ がそれぞれのボタンです。'));
  parts.push(makeImageBlock(img2));
  parts.push(
    makeTable(
      ['番号', 'ボタン・画面の場所', '押すと何ができる？ どう動く？'],
      [
        ['①', '`詳細設定` の4項目（すべて既定 ON）', '・**画面スクリーンショット認識**: 画面の見た目も一緒に確認して押し間違いを防ぎます。\n・**バックグラウンド実行を許可**: パネルを閉じたり別タブを見ていても裏で作業を続けます。\n・**複数タブ作業を許可**: 開いたページを「Nano AI」という名前のタブグループに自動でまとめます。\n・**簡易ビュワーで開く**: 画像・動画・PDF リンクを踏んだときにパソコンへダウンロードせず別タブで開きます（第4章参照）。'],
        ['②', '`手順書をアップロード`（または点線枠へドラッグ）', 'Word（`.docx`）、PowerPoint（`.pptx`）、Excel（`.xlsx`）、PDF（`.pdf`）、テキストファイルなどを読み込みます。**Word や Excel の中に貼ってある画面スクリーンショットも自動で読み取って参考にします。**'],
        ['③', '`Word (.docx) テンプレDL`', 'AI が読み取りやすい形式の Word ひな形（`gemini-nano-playbook-template.docx`）をダウンロードします。この Word に手順と画面写真を貼ってアップロードすればそのまま使えます。'],
        ['④', '`SKILL.md をダウンロード` リンク', 'すでに社内にある「バラバラな形式の手順書やメモ」を、**Web 版の高性能な Gemini に読ませるだけで AI 用の整った手順書に自動変換できるファイル（`SKILL.md`）** をダウンロードします。'],
        ['⑤', '`コピー` ボタン', '上の ④ の変換用ファイルをダウンロードせず、中身をそのままコピーします。Web 版 Gemini の入力欄へ貼り付けて使えます。'],
        ['⑥', '`目標欄へセット` / 右上の `解除`', '読み込んだ手順書の「目的」をそのまま上の指示欄へコピーします。別の作業をしたいときは右上の **「解除」** で手順書を外せます。']
      ],
      [800, 2700, 6138]
    )
  );

  parts.push(
    makeCallout(
      'すでにある手順書を Web 版 Gemini で変換する 3 ステップ',
      [
        '1. 上の ④（または ⑤）から `SKILL.md` を手に入れます。',
        '2. ブラウザで普段使っている **Web 版 Google Gemini** を開き、`SKILL.md` と「元のバラバラな手順書（Word やメモ書き等）」を一緒に渡して「このスキル通りに変換して」と頼みます。',
        '3. できあがった文章をファイル保存（`.md`）するか、③の Word テンプレートに貼り付けて保存し、②の **「手順書をアップロード」** から読み込ませれば完了です！'
      ],
      'info'
    )
  );

  // Section 2.3 Running / Confirm / Log
  parts.push(h2('2.3 AI が作業中の画面（確認カード・タブ管理・作業記録）'));
  parts.push(p('「実行開始」を押すと、下の図3のように作業が進みます。途中で大事な確認が出たときの操作もここで覚えましょう。'));
  parts.push(makeImageBlock(img3));
  parts.push(
    makeTable(
      ['番号', 'ボタン・画面の場所', '押すと何ができる？ どう動く？'],
      [
        ['①', '`緊急停止` ボタン', '作業中だけ赤く表示されます。いつでも即座に AI の動きを止めることができます。'],
        ['②', 'タブグループ欄（`Nano AI`）', 'AI が今使っているページの一覧です。`#1 社内ポータル` などのボタンを押すと、そのページをすぐ画面に出して様子を見ることができます。'],
        ['③', '確認・質問カード（黄色い枠）', '送信・購入・削除・ログインなどの大事な場面や、手順書に書かれていない画面が出て AI が迷ったときに表示されます。'],
        ['④', '`許可して続行` / `中断`（＋返答入力欄）', 'AI の提案どおり進めてよければ **「許可して続行」** を押します。AI に「こう直して」と伝えたいときは入力欄に文字を書いてから押します。やめる場合は赤い **「中断」** を押します（手順を飛ばせるときは「この手をスキップ」ボタンも出ます）。'],
        ['⑤', '実行ログ（作業記録）', 'AI が「何を考えて・どこを押したか」の記録が順番に並びます。表示されている小さい画面写真をクリックすると、大きく拡大して見ることができます。']
      ],
      [800, 2700, 6138]
    )
  );

  // Chapter 3
  parts.push(h1('第3章 よく使う作業を「図」にしてワンクリック実行', { pageBreakBefore: true }));
  parts.push(p('毎回同じ言葉を打ち込まなくても、作業の流れを「フロー図」として保存しておけば、次からはボタン 1 回で動かせるようになります。'));

  parts.push(h2('3.1 「フロー設計」タブの使い方'));
  parts.push(makeImageBlock(img4));
  parts.push(
    makeTable(
      ['番号', 'ボタン名', '押すと何ができる？ どう動く？'],
      [
        ['①', '`Studio で詳細設計（別ページ）`', '広い画面で作業ブロックをつないでフロー図を作れる専用ページ（図5）を別タブで開きます。'],
        ['②', '`更新`', '別ページで新しく作ったフロー図を一覧に反映させます。'],
        ['③', '`呼出（適用）`', '保存されている作業を「AI 操作」画面へセットします（少しだけ指示を変えて動かしたいときに便利です）。'],
        ['④', '`ワンクリック実行`', '保存されている作業をそのまま最初からスタートします。右横の **「Studio編集」** を押すとその図を手直しできます。'],
        ['⑤', 'プレビュー画面', '今選んでいる作業がどのような順番や「もし〜なら（YES / NO）」の枝分かれで動くかを下に表示します。']
      ],
      [800, 2700, 6138]
    )
  );

  parts.push(h2('3.2 専用設計画面（Nano Flow Studio）の見方と作り方'));
  parts.push(p('①の「Studio で詳細設計（別ページ）」を押すと、下のような広い専用画面が開きます。パズルのようにブロックを並べてつなぐだけで自動手順が作れます。'));
  parts.push(makeImageBlock(img5));
  parts.push(
    makeTable(
      ['番号', 'ボタン・画面の場所', '押すと何ができる？ どう動く？'],
      [
        ['①', '`元に戻す` (`Ctrl+Z`)', 'ブロックを消したり動かしたりした直前の操作を 1 つ前に戻します（最大 50 回前まで）。'],
        ['②', '`自動整列` (`Ctrl+L`)', 'ごちゃごちゃになったブロックを、上から下へきれいな並びに自動で整えます。'],
        ['③', '`AI手順書プレビュー`', '今作った図が「AI への指示文」としてどのように整理されているかを画面で確認します。'],
        ['④', '`ローカルに保存` (`Ctrl+S`)', '作った図をブラウザに保存します。隣の **「JSON書出」「JSON読込」** でファイルとして保存・他のパソコンへ受け渡しもできます。'],
        ['⑤', '`このフローを実行`', '今作った図を保存して、そのまま AI に実行させます。'],
        ['⑥', '`+ 新規` / `複製` / `削除`', '新しいフロー図をゼロから作ったり、今ある図をコピーしたり、いらない図を消したりします。'],
        ['⑦', 'ブロック配置メニュー（4種類）', '「操作ステップ」「条件分岐 (IF)」「人間に確認」「フロー完了」のボタンを、中央のマス目へドラッグ＆ドロップ（またはクリック）して増やします。'],
        ['⑧', '右側の詳細設定欄', '中央でクリックして選んだブロック（青い枠）について、「開く URL」「押すボタン」「条件（〜が表示されていたら）」などを日本語で入力します。複数選んだときは一括コピー／削除ボタンが出ます。']
      ],
      [800, 2700, 6138]
    )
  );

  parts.push(h3('ブロックのつなぎ方と便利なキーボード操作'));
  parts.push(
    bullets([
      '**線をつなぐ**: ブロックの下側にある `● 次へ接続`（または `● YES` / `● NO`）をクリックしてから、つなぎたい次のブロックをクリックします。または **`Ctrl` キーを押しながら「元のブロック」→「次のブロック」の順にクリック** でもすぐつながります。',
      '**線を外す**: つなぎ線の真ん中にある `✕`（または `YES ✕` / `NO ✕`）をクリックすると切れます。',
      '**複数まとめて選ぶ**: マス目の何もない場所をドラッグ（囲む）すると、複数のブロックを一度に選んでまとめて動かせます。'
    ])
  );
  parts.push(
    makeTable(
      ['キーボード / マウス操作', 'できること（Excel や PowerPoint と同じ感覚で使えます）'],
      [
        ['`Ctrl + C` / `Ctrl + X`', '選んでいるブロックをコピー / 切り取りします（開始ブロックは除く）。'],
        ['`Ctrl + V`', 'コピーしたブロックを、今 **マウスカーソルが置いてある場所** に貼り付けます。'],
        ['`Ctrl + A`', '画面上のすべてのブロックをまとめて選びます。'],
        ['`Ctrl + Z`', 'ひとつ前の操作に戻ります。'],
        ['`Ctrl + S` / `Ctrl + L`', '`Ctrl + S` で保存、`Ctrl + L` で自動整列します。'],
        ['`Ctrl + クリック1` → `Ctrl + クリック2`', '1回目に押したブロックから 2回目に押したブロックへ自動で線をつなぎます。'],
        ['`Delete` / `Backspace`', '選んでいるブロックを削除します（`Esc` でつなぎ作業をキャンセルできます）。']
      ],
      [3400, 6238]
    )
  );

  // Chapter 4
  parts.push(h1('第4章 画像・動画・PDF・Illustrator ファイルを見る画面（簡易ビュワー）', { pageBreakBefore: true }));
  parts.push(
    p(
      '通常、Chrome で PDF や画像・動画などのリンクを押すと、ファイルが自分のパソコンにダウンロードされてしまい、拡張機能の AI が中身を見られなくなることがあります。そこで本ツールには、**ダウンロードする代わりに Chrome の別タブで直接開いて AI と一緒に見られる「簡易ビュワー」** が付いています。'
    )
  );

  parts.push(h2('4.1 簡易ビュワーで見られるファイル一覧'));
  parts.push(
    makeTable(
      ['種類', '対応しているファイル（拡張子）', 'AI と人間でどう見える？'],
      [
        ['画像ファイル', '`.jpg` / `.jpeg` / `.jfif` / `.png` / `.bmp` / `.webp` / `.gif`', '別タブに画像を大きく表示し、AI もその画像を見て内容を読み取ります。'],
        ['Illustrator ファイル', '`.ai`（Adobe Illustrator）', 'PDF 互換データが入っている `.ai` はプレビューと文字の両方を表示・読取。古い形式の `.ai` もファイル内の文字情報を抜き出して読めます。'],
        ['動画ファイル', '`.mp4`（H.264 / H.265）・`.mov`', '別タブの動画プレイヤーで再生でき、AI は再生中の場面の映像を見て中身を確認できます。'],
        ['PDF 文書', '`.pdf`', '別タブに PDF 画面を表示し、同時に文字データも抜き出して AI が全ページを読めるようにします。']
      ],
      [2000, 3200, 4438]
    )
  );

  parts.push(h2('4.2 簡易ビュワー画面のボタン説明'));
  parts.push(makeImageBlock(img6));
  parts.push(
    makeTable(
      ['番号', 'ボタン・画面の場所', '押すと何ができる？ どう動く？'],
      [
        ['①', 'ファイル形式バッジと情報欄', '今開いているファイルの種類（`PNG画像` や `PDF文書` など）、ファイル名、サイズが表示されます。'],
        ['②', '`ローカルファイルを開く`', '自分のパソコンに入っている画像・動画・PDF・`.ai` ファイルを手動で選んで開きたいときに使います（画面にドラッグ＆ドロップしても開けます）。'],
        ['③', '`ローカルに保存`', 'AI がリンクから開いたファイルを手元のパソコンにも保存したいときに押します。'],
        ['④', '操作ツールバー（画像時：`縮小` / `100%` / `拡大`）', '画像を見やすい大きさに変えます。**動画のとき**は「再生/一時停止」「5秒戻る」「5秒進む」「先頭へ」「25%」「50%」「75%」、**PDF・`.ai` のとき**は「プレビュー」「抽出テキスト」「前のページ」「次のページ」ボタンに自動で切り替わり、AI もこれらを押して確認できます。'],
        ['⑤', '`90°回転`（画像時）', '横向きや逆さまの画像を 90° ずつ回して正しい向きに直します。']
      ],
      [800, 2700, 6138]
    )
  );

  // Chapter 5
  parts.push(h1('第5章 困ったときの Q&A', { pageBreakBefore: true }));
  parts.push(
    makeTable(
      ['よくあるお困りごと', '解決方法'],
      [
        ['上部のステータスが赤い丸になり「利用できません」と出る', '第1章の 3 つの設定がオンになっているか確認し、Chrome を一度すべて閉じて開き直してください。またパソコンの保存空き容量が少ないと準備が完了しないことがあります。'],
        ['AI が途中で止まって黄色い確認カードが出る', '安全のためのブレーキ、または手順書に書かれていない画面が出て迷っているサインです。画面を見て問題なければ **「許可して続行」** を押すか、文字入力欄に「〇〇をクリックして」と教えてあげてください。'],
        ['簡易ビュワーで一部の `.mp4` や `.mov` 動画が再生できない', '動画の形式（H.265 など）によっては、お使いのパソコン側の再生機能が対応していない場合があります。そのときは画面右上の **「ローカルに保存」** を押して、Windows のメディアプレイヤー等でお開きください。'],
        ['「Unknown message type」などの見慣れないエラーが出た', 'ツールを更新したあと、以前から開いていたパネルやタブが古いまま残っているときに起きることがあります。サイドパネルを一度閉じて開き直し、操作していたページも再読み込み（更新ボタン）してください。'],
        ['間違えて手順書を消したり、フロー図を壊してしまった', 'Studio 画面では **`元に戻す` (`Ctrl+Z`)** で 50 回前までやり直せます。また手順書は何度でもアップロードし直せます。']
      ],
      [3300, 6338]
    )
  );

  return parts.join('');
}

// --- OOXML Static Parts ---

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const IMAGE_RELS_XML = IMAGES_META.map(
  (img) =>
    `  <Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.zipPath.replace('word/media/', '')}"/>`
).join('\n');

const DOC_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
${IMAGE_RELS_XML}
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Meiryo UI" w:hAnsi="Meiryo UI" w:eastAsia="Meiryo UI"/>
        <w:color w:val="0F172A"/>
        <w:sz w:val="20"/>
        <w:szCs w:val="20"/>
        <w:lang w:val="ja-JP" w:eastAsia="ja-JP"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="100" w:line="280" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="200" w:after="140"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="1E3A8A"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="1E40AF"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="140" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="0F172A"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>
  </w:style>
</w:styles>`;

const HEADER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p>
    <w:pPr><w:jc w:val="right"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="E2E8F0"/></w:pBdr></w:pPr>
    <w:r><w:rPr><w:rFonts w:ascii="Meiryo UI" w:hAnsi="Meiryo UI" w:eastAsia="Meiryo UI"/><w:color w:val="64748B"/><w:sz w:val="16"/></w:rPr><w:t>Gemini Nano Computer Use — 図解つき操作マニュアル</w:t></w:r>
  </w:p>
</w:hdr>`;

const FOOTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:r><w:rPr><w:rFonts w:ascii="Meiryo UI" w:hAnsi="Meiryo UI" w:eastAsia="Meiryo UI"/><w:color w:val="64748B"/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve">- </w:t></w:r>
    <w:fldSimple w:instr="PAGE"><w:r><w:rPr><w:sz w:val="16"/><w:color w:val="64748B"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>
    <w:r><w:rPr><w:rFonts w:ascii="Meiryo UI" w:hAnsi="Meiryo UI" w:eastAsia="Meiryo UI"/><w:color w:val="64748B"/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve"> / </w:t></w:r>
    <w:fldSimple w:instr="NUMPAGES"><w:r><w:rPr><w:sz w:val="16"/><w:color w:val="64748B"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>
    <w:r><w:rPr><w:rFonts w:ascii="Meiryo UI" w:hAnsi="Meiryo UI" w:eastAsia="Meiryo UI"/><w:color w:val="64748B"/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve"> -</w:t></w:r>
  </w:p>
</w:ftr>`;

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${buildManualBodyXml()}
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rId2"/>
      <w:footerReference w:type="default" r:id="rId3"/>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
const zipBuffer = buildZip([
  { name: '[Content_Types].xml', data: CONTENT_TYPES_XML },
  { name: '_rels/.rels', data: ROOT_RELS_XML },
  { name: 'word/document.xml', data: DOCUMENT_XML },
  { name: 'word/_rels/document.xml.rels', data: DOC_RELS_XML },
  { name: 'word/styles.xml', data: STYLES_XML },
  { name: 'word/header1.xml', data: HEADER_XML },
  { name: 'word/footer1.xml', data: FOOTER_XML },
  ...IMAGES_META.map((img) => ({ name: img.zipPath, data: img.bytes, store: true }))
]);

writeFileSync(OUTPUT_PATH, zipBuffer);
console.log(`Generated visual DOCX manual: ${OUTPUT_PATH} (${zipBuffer.length} bytes, ${IMAGES_META.length} images)`);
