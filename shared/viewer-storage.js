const DB_NAME = 'nano_cu_viewer_db';
const DB_VERSION = 1;
const STORE_NAME = 'media';
const MAX_MEDIA_RECORDS = 8;

function openViewerDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB がこの環境で利用できません。'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB のオープンに失敗しました。'));
  });
}

function generateMediaId() {
  return `med_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function listViewerMedia() {
  const db = await openViewerDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const rows = Array.isArray(req.result) ? req.result : [];
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      resolve(
        rows.map((r) => ({
          id: r.id,
          filename: r.filename,
          sourceUrl: r.sourceUrl || '',
          mimeType: r.mimeType,
          category: r.category,
          ext: r.ext,
          byteLength: r.bytes?.byteLength || r.byteLength || 0,
          createdAt: r.createdAt || 0
        }))
      );
    };
    req.onerror = () => reject(req.error || new Error('一覧取得に失敗しました。'));
    tx.oncomplete = () => db.close();
  });
}

export async function getViewerMedia(id) {
  if (!id) return null;
  const db = await openViewerDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => {
      const row = req.result || null;
      if (row && row.bytes && !(row.bytes instanceof Uint8Array)) {
        row.bytes = new Uint8Array(row.bytes);
      }
      resolve(row);
    };
    req.onerror = () => reject(req.error || new Error('データの読み込みに失敗しました。'));
    tx.oncomplete = () => db.close();
  });
}

export async function deleteViewerMedia(id) {
  if (!id) return;
  const db = await openViewerDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error || new Error('削除に失敗しました。'));
  });
}

export async function saveViewerMedia(record) {
  const bytes =
    record?.bytes instanceof Uint8Array
      ? record.bytes
      : new Uint8Array(record?.bytes || 0);

  const entry = {
    id: record?.id || generateMediaId(),
    filename: String(record?.filename || 'media'),
    sourceUrl: String(record?.sourceUrl || ''),
    mimeType: String(record?.mimeType || 'application/octet-stream'),
    category: String(record?.category || 'document'),
    ext: String(record?.ext || ''),
    byteLength: bytes.byteLength,
    bytes,
    createdAt: record?.createdAt || Date.now()
  };

  const db = await openViewerDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(entry);

    const allReq = store.getAll();
    allReq.onsuccess = () => {
      const all = Array.isArray(allReq.result) ? allReq.result : [];
      if (all.length > MAX_MEDIA_RECORDS) {
        all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        for (const stale of all.slice(MAX_MEDIA_RECORDS)) {
          if (stale.id !== entry.id) {
            store.delete(stale.id);
          }
        }
      }
    };

    tx.oncomplete = () => {
      db.close();
      resolve(entry);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('IndexedDB への保存に失敗しました。'));
    };
  });
}
