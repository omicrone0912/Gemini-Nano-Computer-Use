import test from 'node:test';
import assert from 'node:assert/strict';
import { NanoClient } from '../shared/nano-client.js';

test('NanoClient checks multimodal availability and falls back to text-only on NotSupportedError', async () => {
  let createCalls = 0;
  let clonedDestroyed = 0;
  let baseDestroyed = 0;

  const mockEnv = {
    LanguageModel: {
      async availability(opts) {
        const hasImage = opts?.expectedInputs?.some((i) => i.type === 'image');
        return hasImage ? 'unavailable' : 'available';
      },
      async create(opts) {
        createCalls += 1;
        const hasImage = opts?.expectedInputs?.some((i) => i.type === 'image');
        if (hasImage) {
          const err = new Error('image input is not supported');
          err.name = 'NotSupportedError';
          throw err;
        }
        return {
          async clone() {
            return {
              inputUsage: 120,
              inputQuota: 4096,
              async prompt(_payload, pOpts) {
                if (pOpts?.responseConstraint) {
                  const err = new Error('responseConstraint not supported');
                  err.name = 'NotSupportedError';
                  throw err;
                }
                return JSON.stringify({
                  thought: '完了します',
                  action: 'done',
                  message: '確認しました'
                });
              },
              destroy() {
                clonedDestroyed += 1;
              }
            };
          },
          destroy() {
            baseDestroyed += 1;
          }
        };
      }
    }
  };

  const client = new NanoClient(mockEnv);
  const avail = await client.checkAvailability();
  assert.equal(avail.supported, true);
  assert.equal(avail.status, 'available');
  assert.equal(avail.multimodal, false);

  const init = await client.initialize({ useVision: true });
  assert.equal(init.multimodal, false);
  assert.equal(createCalls, 2);

  const res = await client.decideAction({ promptText: 'test prompt' });
  assert.equal(res.action.action, 'done');
  assert.equal(res.usage.usedConstraint, false);
  assert.equal(clonedDestroyed, 1);

  await client.destroy();
  assert.equal(baseDestroyed, 1);
});

test('NanoClient passes image content when multimodal session succeeds', async () => {
  let capturedPayload = null;
  const fakeBlob = { size: 10, type: 'image/jpeg' };

  const mockEnv = {
    LanguageModel: {
      async availability() {
        return 'available';
      },
      async create() {
        return {
          async clone() {
            return {
              async prompt(payload) {
                capturedPayload = payload;
                return JSON.stringify({ thought: 'クリック', action: 'click', elementId: 2 });
              },
              destroy() {}
            };
          },
          destroy() {}
        };
      }
    }
  };

  const client = new NanoClient(mockEnv);
  const init = await client.initialize({ useVision: true });
  assert.equal(init.multimodal, true);

  const res = await client.decideAction({ promptText: '画面を見て', image: fakeBlob });
  assert.equal(res.action.action, 'click');
  assert.equal(res.action.elementId, 2);
  assert.ok(Array.isArray(capturedPayload));
  assert.ok(capturedPayload[0].content.some((item) => item.type === 'image' && item.value === fakeBlob));
});

test('NanoClient includes referenceImages and falls back cleanly on QuotaExceededError', async () => {
  let promptCalls = 0;
  const mainBlob = { size: 10, type: 'image/jpeg' };
  const refDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  const mockEnv = {
    LanguageModel: {
      async availability() {
        return 'available';
      },
      async create() {
        return {
          async clone() {
            return {
              async prompt(payload) {
                promptCalls += 1;
                const imageCount = Array.isArray(payload)
                  ? payload[0].content.filter((c) => c.type === 'image').length
                  : 0;
                if (imageCount > 1) {
                  const err = new Error('Too many images');
                  err.name = 'QuotaExceededError';
                  throw err;
                }
                return JSON.stringify({ thought: '1枚で判定', action: 'click', elementId: 1 });
              },
              destroy() {}
            };
          },
          destroy() {}
        };
      }
    }
  };

  const client = new NanoClient(mockEnv);
  await client.initialize({ useVision: true });
  const res = await client.decideAction({
    promptText: '手順書に沿って実行',
    image: mainBlob,
    referenceImages: [{ index: 1, name: 'step1.png', dataUrl: refDataUrl, stepHint: '1. [click]' }]
  });

  assert.equal(promptCalls, 2);
  assert.equal(res.action.action, 'click');
  assert.equal(res.usage.usedVision, true);
});
