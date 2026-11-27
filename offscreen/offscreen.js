import { MSG_TYPES } from '../shared/constants.js';
import { NanoClient } from '../shared/nano-client.js';
import { QwenLocalClient } from '../shared/qwen-client.js';
import { annotateScreenshot } from '../sidepanel/annotator.js';

const nanoClient = new NanoClient(globalThis);
let activeClient = nanoClient;
let activeAbortController = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen' || typeof message.type !== 'string') {
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case MSG_TYPES.OFFSCREEN_NANO_INIT: {
          const onProgress = (percent) => {
            chrome.runtime
              .sendMessage({
                type: MSG_TYPES.AGENT_EVENT,
                event: { type: 'model_download_progress', percent, timestamp: Date.now() }
              })
              .catch(() => {});
          };

          let result;
          if (message.provider === 'qwen_local') {
            await nanoClient.destroy().catch(() => {});
            const qwenClient = new QwenLocalClient({
              endpoint: message.qwenEndpoint,
              model: message.qwenModel
            });
            result = await qwenClient.initialize({
              useVision: Boolean(message.useVision),
              systemPrompt: message.systemPrompt,
              onDownloadProgress: onProgress
            });
            activeClient = qwenClient;
          } else {
            try {
              result = await nanoClient.initialize({
                useVision: Boolean(message.useVision),
                systemPrompt: message.systemPrompt,
                onDownloadProgress: onProgress
              });
              activeClient = nanoClient;
            } catch (nanoError) {
              if (!message.useQwenFallback) {
                throw nanoError;
              }
              const qwenClient = new QwenLocalClient({
                endpoint: message.qwenEndpoint,
                model: message.qwenModel
              });
              result = await qwenClient.initialize({
                useVision: Boolean(message.useVision),
                systemPrompt: message.systemPrompt,
                onDownloadProgress: onProgress
              });
              activeClient = qwenClient;
            }
          }
          sendResponse({ ok: true, ...result });
          break;
        }

        case MSG_TYPES.OFFSCREEN_NANO_DECIDE: {
          if (activeAbortController) {
            activeAbortController.abort();
          }
          activeAbortController = new AbortController();
          const { signal } = activeAbortController;

          let image = null;
          let previewDataUrl = null;
          if (message.rawScreenshotDataUrl) {
            try {
              const annotated = await annotateScreenshot(
                message.rawScreenshotDataUrl,
                message.snapshot,
                message.maxImageWidth || 768
              );
              image = annotated.blob;
              previewDataUrl = annotated.previewDataUrl;
            } catch {
              // Fall back to DOM-only inference if canvas annotation fails
            }
          }

          const decision = await activeClient.decideAction({
            promptText: message.promptText,
            image,
            referenceImages: Array.isArray(message.referenceImages) ? message.referenceImages : [],
            signal
          });
          activeAbortController = null;

          sendResponse({
            ok: true,
            action: decision.action,
            usage: decision.usage,
            previewDataUrl
          });
          break;
        }

        case MSG_TYPES.OFFSCREEN_NANO_ABORT: {
          if (activeAbortController) {
            activeAbortController.abort();
            activeAbortController = null;
          }
          sendResponse({ ok: true });
          break;
        }

        case MSG_TYPES.OFFSCREEN_NANO_DESTROY: {
          if (activeAbortController) {
            activeAbortController.abort();
            activeAbortController = null;
          }
          await activeClient.destroy();
          activeClient = nanoClient;
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown offscreen message: ${message.type}` });
          break;
      }
    } catch (error) {
      activeAbortController = null;
      sendResponse({
        ok: false,
        aborted: error?.name === 'AbortError',
        error: error?.message || String(error)
      });
    }
  })();

  return true;
});
