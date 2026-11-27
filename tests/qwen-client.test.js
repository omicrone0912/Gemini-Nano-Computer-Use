import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QWEN_DEFAULT_ENDPOINT,
  QWEN_DEFAULT_MODEL,
  QwenLocalClient,
  generateQwenPowerShellOneLiner,
  generateQwenWindowsInstallerBat,
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
  assert.match(bat, /setx OLLAMA_ORIGINS "chrome-extension:\/\/\*,http:\/\/localhost:\*,http:\/\/127\.0\.0\.1:\*"/);
  assert.match(bat, /"%OLLAMA_EXE%" pull qwen2\.5vl:7b/);

  const ps = generateQwenPowerShellOneLiner('qwen2.5vl:3b');
  assert.match(ps, /OLLAMA_ORIGINS/);
  assert.match(ps, /pull qwen2\.5vl:3b/);
});
