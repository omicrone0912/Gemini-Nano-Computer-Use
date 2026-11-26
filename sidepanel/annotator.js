function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('スクリーンショット画像の読み込みに失敗しました。'));
    img.src = dataUrl;
  });
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas から Blob の生成に失敗しました。'));
    }, type, quality);
  });
}

/**
 * Draw Set-of-Mark bounding boxes and numeric badges onto the captured tab screenshot.
 */
export async function annotateScreenshot(dataUrl, snapshot, maxWidth = 768) {
  const img = await loadImageFromDataUrl(dataUrl);
  const scale = img.naturalWidth > maxWidth ? maxWidth / img.naturalWidth : 1;
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);

  const vw = snapshot?.viewport?.width || img.naturalWidth;
  const vh = snapshot?.viewport?.height || img.naturalHeight;
  const sx = width / vw;
  const sy = height / vh;

  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];

  ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'middle';

  for (const el of elements) {
    if (!el.rect) continue;
    const x = Math.round(el.rect.x * sx);
    const y = Math.round(el.rect.y * sy);
    const w = Math.max(8, Math.round(el.rect.width * sx));
    const h = Math.max(8, Math.round(el.rect.height * sy));

    // Bounding box
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);

    // Numeric badge
    const label = String(el.id);
    const textWidth = ctx.measureText(label).width;
    const badgeW = Math.max(16, Math.round(textWidth + 7));
    const badgeH = 15;
    const badgeX = Math.max(0, Math.min(width - badgeW, x));
    const badgeY = y >= badgeH ? y - badgeH : Math.min(height - badgeH, y + 2);

    ctx.fillStyle = '#dc2626';
    ctx.fillRect(badgeX, badgeY, badgeW, badgeH);

    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, badgeX + 3.5, badgeY + badgeH / 2 + 0.5);
  }

  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.85);
  const previewDataUrl = canvas.toDataURL('image/jpeg', 0.8);

  return {
    canvas,
    blob,
    previewDataUrl,
    width,
    height
  };
}
