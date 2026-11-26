import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = pathResolve(__dirname, '..');
const OUT_DIR = pathResolve(ROOT_DIR, 'docs/manual-images');

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LocalAppData || ''}\\Google\\Chrome\\Application\\chrome.exe`
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('Google Chrome が見つかりませんでした。');
}

function buildInjectedHarness(scene) {
  return `
<style id="__manual_capture_light_override__">
  :root { color-scheme: light !important; }
  body { overflow: hidden !important; }
  .__cap-badge {
    position: fixed;
    z-index: 2147483647;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    background: #dc2626;
    color: #ffffff;
    border: 2px solid #ffffff;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.38);
    font: 700 12px/18px system-ui, -apple-system, 'Segoe UI', sans-serif;
    text-align: center;
    pointer-events: none;
  }
</style>
<script>
(function() {
  const SCENE = ${JSON.stringify(scene)};
  const memStore = {};

  function makeSamplePreviewDataUrl() {
    try {
      const c = document.createElement('canvas');
      c.width = 480;
      c.height = 240;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 480, 240);
      ctx.fillStyle = '#eff6ff';
      ctx.fillRect(0, 0, 480, 44);
      ctx.fillStyle = '#1e3a8a';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText('社内申請ポータル - 検索画面', 16, 28);
      ctx.strokeStyle = '#cbd5e1';
      ctx.strokeRect(20, 68, 280, 36);
      ctx.fillStyle = '#0f172a';
      ctx.font = '14px sans-serif';
      ctx.fillText('今月の売上一覧', 32, 91);
      ctx.fillStyle = '#2563eb';
      ctx.fillRect(312, 68, 96, 36);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('検索する', 332, 91);
      // Red Set-of-Mark box
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 2;
      ctx.strokeRect(310, 66, 100, 40);
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(310, 50, 18, 16);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('4', 315, 62);
      return c.toDataURL('image/png');
    } catch {
      return '';
    }
  }

  window.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      prompt: async () => '{"action":"done","message":"完了"}',
      destroy: () => {}
    })
  };

  window.chrome = {
    runtime: {
      getURL: (path) => new URL('../' + path.replace(/^\\//, ''), window.location.href).href,
      sendMessage: async (msg) => {
        if (!msg || !msg.type) return { ok: true };
        if (msg.type === 'NANO_CU_GET_BACKGROUND_RUN_STATE') {
          if (SCENE === 'confirm-log') {
            return {
              ok: true,
              workspace: {
                groupId: 12,
                groupTitle: 'Nano AI',
                multiTabEnabled: true,
                backgroundMode: true,
                currentTabId: 102,
                tabs: [
                  { index: 1, tabId: 101, title: '社内ポータル', url: 'https://portal.example.com', isCurrent: false },
                  { index: 2, tabId: 102, title: '申請確認画面', url: 'https://portal.example.com/submit', isCurrent: true }
                ]
              },
              state: {
                running: true,
                goal: '社内ポータルで今月の申請書を確認して提出前まで進めてください。',
                events: [
                  { type: 'run_started', timestamp: Date.now() - 5000 },
                  { type: 'session_ready', multimodal: true, timestamp: Date.now() - 4500 },
                  { type: 'step_started', step: 1, maxSteps: 15, timestamp: Date.now() - 4000 },
                  { type: 'observation_captured', step: 1, previewDataUrl: makeSamplePreviewDataUrl(), timestamp: Date.now() - 3500 },
                  {
                    type: 'action_planned',
                    step: 1,
                    action: { action: 'click', thought: '検索結果の「今月の申請」を開きます。' },
                    summary: '要素 #4 をクリック',
                    timestamp: Date.now() - 3000
                  },
                  { type: 'step_completed', step: 1, result: { ok: true, detail: '要素 #4 をクリックしました。' }, durationMs: 420, timestamp: Date.now() - 2500 },
                  { type: 'step_started', step: 2, maxSteps: 15, timestamp: Date.now() - 2000 },
                  {
                    type: 'action_planned',
                    step: 2,
                    action: { action: 'ask_user', thought: '送信ボタンの前に人間の確認が必要です。' },
                    summary: 'ユーザー確認: 申請内容を確認してください',
                    timestamp: Date.now() - 1500
                  }
                ],
                pendingConfirmation: {
                  step: 2,
                  kind: 'ask_user',
                  title: 'AI からの確認・質問',
                  reason: '申請内容（金額: 12,800円）に間違いがなければ「許可して続行」を押してください。修正点があれば下の欄にご入力ください。',
                  action: { action: 'click', label: '申請を確定して送信' },
                  allowCustomReply: true
                }
              }
            };
          }
          return { ok: true, state: { running: false, events: [] }, workspace: null };
        }
        return { ok: true };
      },
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: {
        get: async (key) => (key ? { [key]: memStore[key] } : { ...memStore }),
        set: async (obj) => Object.assign(memStore, obj)
      },
      onChanged: { addListener: () => {} }
    },
    tabs: {
      query: async () => [{ id: 101, windowId: 1, url: 'https://example.com', title: 'Example', active: true }],
      create: async (opts) => ({ id: 201, ...opts }),
      getCurrent: async () => ({ id: 301 })
    },
    downloads: {
      download: async () => 1,
      search: async () => []
    }
  };

  function placeBadge(num, target, pos = 'tl') {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const badge = document.createElement('div');
    badge.className = '__cap-badge';
    badge.textContent = String(num);

    let x = rect.left - 8;
    let y = rect.top - 8;
    if (pos === 'tr') {
      x = rect.right - 14;
      y = rect.top - 8;
    } else if (pos === 'bl') {
      x = rect.left - 8;
      y = rect.bottom - 14;
    } else if (pos === 'br') {
      x = rect.right - 14;
      y = rect.bottom - 14;
    } else if (pos === 'in-tl') {
      x = rect.left + 8;
      y = rect.top + 8;
    } else if (pos === 'in-tr') {
      x = rect.right - 30;
      y = rect.top + 8;
    }

    x = Math.max(4, Math.min(window.innerWidth - 26, Math.round(x)));
    y = Math.max(4, Math.min(window.innerHeight - 26, Math.round(y)));
    badge.style.left = x + 'px';
    badge.style.top = y + 'px';
    document.body.appendChild(badge);
  }

  function makeViewerDemoImageBlob() {
    return new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = 760;
      c.height = 420;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 760, 420);
      ctx.fillStyle = '#1e3a8a';
      ctx.fillRect(0, 0, 760, 56);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText('2026年11月 部門別売上レポート（サンプル画像）', 24, 36);

      const bars = [
        { label: '営業1部', val: 240, h: 190, color: '#2563eb' },
        { label: '営業2部', val: 195, h: 155, color: '#3b82f6' },
        { label: '企画開発', val: 280, h: 220, color: '#16a34a' },
        { label: 'サポート', val: 150, h: 120, color: '#f59e0b' }
      ];
      bars.forEach((b, idx) => {
        const bx = 70 + idx * 170;
        const by = 350 - b.h;
        ctx.fillStyle = b.color;
        ctx.fillRect(bx, by, 90, b.h);
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText(b.label, bx + 12, 378);
        ctx.fillText(b.val + '万円', bx + 16, by - 10);
      });
      c.toBlob((blob) => resolve(blob), 'image/png');
    });
  }

  window.addEventListener('load', () => {
    setTimeout(async () => {
      if (SCENE === 'main') {
        document.getElementById('goalInput').value = '社内ポータルを開いて今月の請求書PDFを簡易ビュワーで確認し、金額の合計を教えて';
        placeBadge(1, '#refreshStatusBtn', 'bl');
        placeBadge(2, '#tabFlowBtn', 'tr');
        placeBadge(3, '#quickApplyPresetBtn', 'tr');
        placeBadge(4, '#goalInput', 'in-tr');
        placeBadge(5, '#advancedSettingsSection', 'tr');
        placeBadge(6, '#runBtn', 'tl');
        placeBadge(7, '#playbookSection', 'tl');
        window.__MANUAL_CAPTURE_READY__ = true;
      } else if (SCENE === 'playbook') {
        document.getElementById('advancedSettingsSection').open = true;
        document.getElementById('playbookSection').open = true;
        const dropZone = document.getElementById('playbookDropZone');
        const sampleMd = '# 手順書タイトル: 月次請求書の確認と報告\\n\\n## 目的\\n社内ポータルから今月の請求書を確認し、合計金額を報告する。\\n\\n## 開始URL\\nhttps://portal.example.com\\n\\n## 実行ステップ\\n1. [navigate] 開始URLへ移動する。\\n2. [click] 「請求書一覧」をクリックする。\\n3. [done] 合計金額を報告する。';
        const f = new File([sampleMd], 'monthly-invoice-sop.md', { type: 'text/markdown' });
        const dt = new DataTransfer();
        dt.items.add(f);
        dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
        setTimeout(() => {
          placeBadge(1, '#advancedSettingsSection', 'tr');
          placeBadge(2, '#uploadPlaybookBtn', 'tl');
          placeBadge(3, '#downloadPlaybookDocxBtn', 'tl');
          placeBadge(4, '#downloadSkillPromptLink', 'tl');
          placeBadge(5, '#copySkillPromptBtn', 'br');
          placeBadge(6, '#applyPlaybookGoalBtn', 'tl');
          window.__MANUAL_CAPTURE_READY__ = true;
        }, 250);
      } else if (SCENE === 'confirm-log') {
        placeBadge(1, '#stopBtn', 'tr');
        placeBadge(2, '#workspaceBar', 'tr');
        placeBadge(3, '#confirmCard', 'tl');
        placeBadge(4, '#confirmApproveBtn', 'bl');
        placeBadge(5, '#timelineList', 'in-tr');
        window.__MANUAL_CAPTURE_READY__ = true;
      } else if (SCENE === 'flow-tab') {
        document.getElementById('tabFlowBtn').click();
        setTimeout(() => {
          placeBadge(1, '#openStudioBtn', 'tr');
          placeBadge(2, '#refreshPresetsBtn', 'tl');
          placeBadge(3, '.flow-preset-card .flow-preset-actions button:nth-child(1)', 'bl');
          placeBadge(4, '.flow-preset-card .flow-preset-actions button:nth-child(2)', 'br');
          placeBadge(5, '#flowPreviewCard', 'tl');
          window.__MANUAL_CAPTURE_READY__ = true;
        }, 250);
      } else if (SCENE === 'studio') {
        setTimeout(() => {
          const canvasArea = document.getElementById('canvasScrollArea');
          if (canvasArea) canvasArea.scrollLeft = 220;
          placeBadge(1, '#undoBtn', 'bl');
          placeBadge(2, '#autoLayoutBtn', 'bl');
          placeBadge(3, '#previewPlaybookBtn', 'bl');
          placeBadge(4, '#savePresetBtn', 'bl');
          placeBadge(5, '#runPresetBtn', 'br');
          placeBadge(6, '#newPresetBtn', 'tr');
          placeBadge(7, '.palette-grid', 'in-tr');
          placeBadge(8, '.studio-inspector', 'in-tr');
          window.__MANUAL_CAPTURE_READY__ = true;
        }, 250);
      } else if (SCENE === 'viewer') {
        const blob = await makeViewerDemoImageBlob();
        const f = new File([blob], 'monthly-sales-chart.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(f);
        document.getElementById('viewerMain').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
        setTimeout(() => {
          placeBadge(1, '#mediaTypeBadge', 'tr');
          placeBadge(2, '#openLocalFileBtn', 'bl');
          placeBadge(3, '#saveLocalBtn', 'br');
          placeBadge(4, '#imgZoomInBtn', 'tr');
          placeBadge(5, '#imgRotateBtn', 'tr');
          window.__MANUAL_CAPTURE_READY__ = true;
        }, 350);
      }
    }, 300);
  });
})();
</script>
`;
}

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      let relPath = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '');
      if (!relPath) relPath = 'sidepanel/sidepanel.html';
      const absPath = pathResolve(ROOT_DIR, relPath);
      if (!absPath.startsWith(ROOT_DIR) || !existsSync(absPath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const ext = extname(absPath).toLowerCase();
      const mime = MIME_MAP[ext] || 'application/octet-stream';
      let content = readFileSync(absPath);

      const scene = reqUrl.searchParams.get('manual_capture');
      if (ext === '.html' && scene) {
        const htmlStr = content.toString('utf8');
        const injected = buildInjectedHarness(scene);
        content = Buffer.from(
          htmlStr.replace(/<script\s+type="module"/i, `${injected}\n  <script type="module"`),
          'utf8'
        );
      }

      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

function launchHeadlessChrome(chromeBin, profileDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      chromeBin,
      [
        '--headless=new',
        `--user-data-dir=${profileDir}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-gpu',
        'about:blank'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stderrLog = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill();
      } catch {}
      reject(new Error(`Chrome DevTools startup timed out. stderr:\n${stderrLog}`));
    }, 15000);

    const onChunk = (chunk) => {
      stderrLog += chunk.toString('utf8');
      const match = stderrLog.match(/DevTools listening on (ws:\/\/[^\r\n]+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, wsUrl: match[1].trim() });
      }
    };

    proc.stderr.on('data', onChunk);
    proc.stdout.on('data', onChunk);
    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Chrome exited prematurely (${code}). stderr:\n${stderrLog}`));
      }
    });
  });
}

async function createCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });

  return { ws, send };
}

async function captureAll() {
  mkdirSync(OUT_DIR, { recursive: true });
  const chromeBin = findChromeBinary();
  const { server, port } = await startStaticServer();
  const profileDir = mkdtempSync(join(tmpdir(), 'nano-cap-'));

  const scenes = [
    { file: '01-sidepanel-main.png', path: '/sidepanel/sidepanel.html?manual_capture=main', w: 430, h: 780 },
    { file: '02-sidepanel-playbook.png', path: '/sidepanel/sidepanel.html?manual_capture=playbook', w: 430, h: 1120 },
    { file: '03-sidepanel-confirm-log.png', path: '/sidepanel/sidepanel.html?manual_capture=confirm-log', w: 430, h: 1160 },
    { file: '04-sidepanel-flow-tab.png', path: '/sidepanel/sidepanel.html?manual_capture=flow-tab', w: 430, h: 780 },
    { file: '05-studio-editor.png', path: '/studio/studio.html?manual_capture=studio', w: 1280, h: 800 },
    { file: '06-media-viewer.png', path: '/viewer/viewer.html?manual_capture=viewer', w: 1040, h: 660 }
  ];

  let proc = null;
  let ws = null;

  try {
    const launched = await launchHeadlessChrome(chromeBin, profileDir);
    proc = launched.proc;
    const cdp = await createCdpClient(launched.wsUrl);
    ws = cdp.ws;

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);

    for (const s of scenes) {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: s.w, height: s.h, deviceScaleFactor: 2, mobile: false },
        sessionId
      );
      await cdp.send(
        'Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-color-scheme', value: 'light' }] },
        sessionId
      );
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}${s.path}` }, sessionId);

      // Wait for scene harness to finish DOM render + badge placement
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const evalRes = await cdp.send(
          'Runtime.evaluate',
          { expression: 'Boolean(window.__MANUAL_CAPTURE_READY__)', returnByValue: true },
          sessionId
        );
        if (evalRes?.result?.value === true) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const outPath = pathResolve(OUT_DIR, s.file);
      writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log(`Captured ${s.file}`);
    }
  } finally {
    try {
      ws?.close();
    } catch {}
    try {
      proc?.kill();
    } catch {}
    server.close();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(profileDir, { recursive: true, force: true });
  }
}

await captureAll();
