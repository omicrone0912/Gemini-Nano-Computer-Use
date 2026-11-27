import test from 'node:test';
import assert from 'node:assert/strict';
import { readZipEntries } from '../shared/office-parser.js';
import { base64ToUint8Array } from '../shared/pdf-parser.js';
import {
  QWEN_DEFAULT_ENDPOINT,
  QWEN_DEFAULT_MODEL,
  QWEN_INSTALLER_BAT_FILENAME,
  QWEN_INSTALLER_ZIP_FILENAME,
  QwenLocalClient,
  buildQwenInstallerBatPayload,
  buildQwenInstallerZipPayload,
  generateQwenPowerShellOneLiner,
  generateQwenWindowsInstallerBat,
  isPendingDownloadDanger,
  startMonitoredChromeDownload,
  validateLocalOllamaEndpoint
} from '../shared/qwen-client.js';

test('validateLocalOllamaEndpoint permits loopback hosts only and rejects external hosts', () => {
  assert.equal(validateLocalOllamaEndpoint('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  assert.equal(validateLocalOllamaEndpoint('http://localhost:11434'), 'http://localhost:11434');
  assert.throws(() => validateLocalOllamaEndpoint('https://api.example.com'), /ローカル/);
  assert.throws(() => validateLocalOllamaEndpoint('http://192.168.1.50:11434'), /ローカル/);
});

test('QwenLocalClient.checkAvailability detects available, downloadable, cors_blocked, and needs_ollama states', async () => {
  const clientAvail = new QwenLocalClient({
    model: 'qwen2.5vl:3b',
    fetchImpl: async () =>
      new Response(JSON.stringify({ models: [{ name: 'qwen2.5vl:3b' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  });
  assert.equal((await clientAvail.checkAvailability()).status, 'available');

  const clientDownloadable = new QwenLocalClient({
    model: 'qwen2.5vl:7b',
    fetchImpl: async () =>
      new Response(JSON.stringify({ models: [{ name: 'qwen2.5vl:3b' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  });
  assert.equal((await clientDownloadable.checkAvailability()).status, 'downloadable');

  const clientCors = new QwenLocalClient({
    fetchImpl: async () => new Response('Forbidden', { status: 403 })
  });
  assert.equal((await clientCors.checkAvailability()).status, 'cors_blocked');

  const clientDown = new QwenLocalClient({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    }
  });
  assert.equal((await clientDown.checkAvailability()).status, 'needs_ollama');
});

test('QwenLocalClient.installModel parses streamed NDJSON progress and emits percentage', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"status":"pulling manifest"}\n'));
      controller.enqueue(encoder.encode('{"status":"downloading","completed":50,"total":200}\n'));
      controller.enqueue(encoder.encode('{"status":"downloading","completed":180,"total":200}\n'));
      controller.enqueue(encoder.encode('{"status":"success"}\n'));
      controller.close();
    }
  });

  const percents = [];
  const client = new QwenLocalClient({
    fetchImpl: async () => new Response(stream, { status: 200 })
  });

  const res = await client.installModel({
    model: 'qwen2.5vl:3b',
    onDownloadProgress: (pct) => percents.push(pct)
  });

  assert.equal(res.ok, true);
  assert.ok(percents.includes(25));
  assert.ok(percents.includes(90));
  assert.equal(percents.at(-1), 100);
});

test('QwenLocalClient.decideAction strips dataUrl prefix, attaches base64 images, and falls back to json format', async () => {
  const requests = [];
  const client = new QwenLocalClient({
    model: 'qwen2.5vl:3b',
    fetchImpl: async (_url, init) => {
      const parsed = JSON.parse(init.body);
      requests.push(parsed);
      if (typeof parsed.format === 'object') {
        return new Response('schema unsupported', { status: 400 });
      }
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              thought: '検索ボタンをクリックします',
              action: 'click',
              elementId: 4
            })
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
  });

  const result = await client.decideAction({
    promptText: '検索を押してください',
    image: new Uint8Array([1, 2, 3, 4]),
    referenceImages: [{ index: 1, name: 'ref.png', dataUrl: 'data:image/png;base64,QUJDRA==' }]
  });

  assert.equal(requests.length, 2);
  assert.equal(typeof requests[0].format, 'object');
  assert.equal(requests[1].format, 'json');
  assert.deepEqual(requests[1].messages[1].images, ['AQIDBA==', 'QUJDRA==']);
  assert.equal(result.action.action, 'click');
  assert.equal(result.action.elementId, 4);
  assert.equal(result.usage.usedConstraint, false);
  assert.equal(result.usage.usedVision, true);
});

test('installer generators emit valid CRLF batch file and PowerShell one-liner with OLLAMA_ORIGINS', () => {
  assert.equal(QWEN_DEFAULT_ENDPOINT, 'http://127.0.0.1:11434');
  assert.equal(QWEN_DEFAULT_MODEL, 'qwen2.5vl:3b');

  const bat = generateQwenWindowsInstallerBat('qwen2.5vl:7b');
  assert.ok(bat.includes('\r\n'));
  assert.match(bat, /chcp 65001 >nul/);
  assert.match(bat, /setx OLLAMA_ORIGINS "chrome-extension:\/\/\*,http:\/\/localhost:\*,http:\/\/127\.0\.0\.1:\*"/);
  assert.match(bat, /"%OLLAMA_EXE%" pull qwen2\.5vl:7b/);

  const ps = generateQwenPowerShellOneLiner('qwen2.5vl:3b');
  assert.match(ps, /OLLAMA_ORIGINS/);
  assert.match(ps, /pull qwen2\.5vl:3b/);
});

test('buildQwenInstallerBatPayload and buildQwenInstallerZipPayload build self-contained base64 data URLs', async () => {
  const batPayload = buildQwenInstallerBatPayload('qwen2.5vl:7b');
  assert.equal(batPayload.filename, QWEN_INSTALLER_BAT_FILENAME);
  assert.ok(batPayload.dataUrl.startsWith('data:application/octet-stream;base64,'));
  const decodedBat = new TextDecoder().decode(
    base64ToUint8Array(batPayload.dataUrl.replace('data:application/octet-stream;base64,', ''))
  );
  assert.equal(decodedBat, batPayload.batSource);
  assert.ok(decodedBat.includes('\r\n'));
  assert.match(decodedBat, /chcp 65001 >nul/);
  assert.match(decodedBat, /"%OLLAMA_EXE%" pull qwen2\.5vl:7b/);

  const zipPayload = buildQwenInstallerZipPayload('qwen2.5vl:3b');
  assert.equal(zipPayload.filename, QWEN_INSTALLER_ZIP_FILENAME);
  assert.ok(zipPayload.dataUrl.startsWith('data:application/zip;base64,'));
  const entries = await readZipEntries(zipPayload.bytes);
  assert.ok(entries.has('install-qwen25vl.bat'));
  assert.ok(entries.has('README.txt'));
  const zippedBat = new TextDecoder().decode(entries.get('install-qwen25vl.bat'));
  assert.match(zippedBat, /"%OLLAMA_EXE%" pull qwen2\.5vl:3b/);
});

test('isPendingDownloadDanger classifies only active danger states as pending', () => {
  assert.equal(isPendingDownloadDanger(''), false);
  assert.equal(isPendingDownloadDanger(null), false);
  assert.equal(isPendingDownloadDanger('safe'), false);
  assert.equal(isPendingDownloadDanger('accepted'), false);
  assert.equal(isPendingDownloadDanger('deepScannedSafe'), false);
  assert.equal(isPendingDownloadDanger('file'), true);
  assert.equal(isPendingDownloadDanger('uncommon'), true);
  assert.equal(isPendingDownloadDanger('content'), true);
});

function createMockDownloadsApi() {
  const listeners = new Set();
  const state = {
    nextId: 10,
    searchItems: [],
    acceptCalls: [],
    acceptShouldReject: false
  };

  return {
    state,
    listeners,
    api: {
      onChanged: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn)
      },
      download: async (opts) => {
        state.lastOpts = opts;
        return state.nextId;
      },
      acceptDanger: async (id) => {
        state.acceptCalls.push(id);
        if (state.acceptShouldReject) {
          throw new Error('Requires visible window');
        }
      },
      search: async ({ id }) => state.searchItems.filter((i) => i.id === id)
    },
    emit: (delta) => {
      for (const fn of [...listeners]) {
        fn(delta);
      }
    }
  };
}

test('startMonitoredChromeDownload handles normal completion and cleans up listener', async () => {
  const mock = createMockDownloadsApi();
  const events = [];

  await startMonitoredChromeDownload({
    downloadsApi: mock.api,
    url: 'data:application/octet-stream;base64,QQ==',
    filename: 'install-qwen25vl.bat',
    saveAs: true,
    onStarted: (e) => events.push(['started', e]),
    onDanger: (e) => events.push(['danger', e]),
    onComplete: (e) => events.push(['complete', e]),
    onInterrupted: (e) => events.push(['interrupted', e])
  });

  assert.equal(mock.state.lastOpts.saveAs, true);
  assert.equal(mock.listeners.size, 1);

  mock.emit({ id: 10, state: { current: 'complete' }, filename: { current: 'C:\\Downloads\\install-qwen25vl.bat' } });
  await Promise.resolve();

  assert.equal(mock.listeners.size, 0);
  assert.deepEqual(events.map((e) => e[0]), ['started', 'complete']);
  assert.equal(events[1][1].filename, 'C:\\Downloads\\install-qwen25vl.bat');
});

test('startMonitoredChromeDownload prompts acceptDanger once for .bat danger state and handles rejection gracefully', async () => {
  const mock = createMockDownloadsApi();
  const events = [];

  await startMonitoredChromeDownload({
    downloadsApi: mock.api,
    url: 'data:application/octet-stream;base64,QQ==',
    filename: 'install-qwen25vl.bat',
    onDanger: (e) => events.push(['danger', e]),
    onComplete: (e) => events.push(['complete', e])
  });

  mock.emit({ id: 10, danger: { current: 'file' } });
  mock.emit({ id: 10, danger: { current: 'file' } });
  await Promise.resolve();
  await Promise.resolve();
  mock.emit({ id: 10, danger: { current: 'accepted' } });
  mock.emit({ id: 10, state: { current: 'complete' } });
  await Promise.resolve();

  assert.deepEqual(mock.state.acceptCalls, [10]);
  assert.equal(events.length, 2);
  assert.equal(events[0][0], 'danger');
  assert.equal(events[0][1].acceptPromptShown, true);
  assert.equal(events[1][0], 'complete');

  const mockReject = createMockDownloadsApi();
  mockReject.state.nextId = 22;
  mockReject.state.acceptShouldReject = true;
  mockReject.state.searchItems = [{ id: 22, state: 'in_progress', danger: 'file', filename: 'install-qwen25vl.bat' }];
  const rejectEvents = [];

  const mon = await startMonitoredChromeDownload({
    downloadsApi: mockReject.api,
    url: 'data:application/octet-stream;base64,QQ==',
    filename: 'install-qwen25vl.bat',
    onDanger: (e) => rejectEvents.push(e)
  });

  await new Promise((r) => setTimeout(r, 10));
  mon.cancelMonitor();

  assert.deepEqual(mockReject.state.acceptCalls, [22]);
  assert.equal(rejectEvents.length, 1);
  assert.equal(rejectEvents[0].acceptPromptShown, false);
  assert.match(rejectEvents[0].acceptError, /visible window/);
});

test('startMonitoredChromeDownload distinguishes USER_CANCELED and FILE_BLOCKED interruptions', async () => {
  const mock1 = createMockDownloadsApi();
  const interrupted1 = [];
  await startMonitoredChromeDownload({
    downloadsApi: mock1.api,
    url: 'data:application/octet-stream;base64,QQ==',
    filename: 'install-qwen25vl.bat',
    onInterrupted: (e) => interrupted1.push(e)
  });
  mock1.emit({ id: 10, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
  assert.equal(mock1.listeners.size, 0);
  assert.deepEqual(interrupted1, [{ downloadId: 10, error: 'USER_CANCELED', canceled: true }]);

  const mock2 = createMockDownloadsApi();
  mock2.state.nextId = 11;
  const interrupted2 = [];
  await startMonitoredChromeDownload({
    downloadsApi: mock2.api,
    url: 'data:application/octet-stream;base64,QQ==',
    filename: 'install-qwen25vl.bat',
    onInterrupted: (e) => interrupted2.push(e)
  });
  mock2.emit({ id: 11, state: { current: 'interrupted' }, error: { current: 'FILE_BLOCKED' } });
  assert.equal(mock2.listeners.size, 0);
  assert.deepEqual(interrupted2, [{ downloadId: 11, error: 'FILE_BLOCKED', canceled: false }]);
});
