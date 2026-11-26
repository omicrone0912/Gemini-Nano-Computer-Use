import { ACTION_RESPONSE_SCHEMA, parseActionResponse } from './action-schema.js';
import { SYSTEM_PROMPT } from './prompt-builder.js';

function getLanguageModelApi(env = globalThis) {
  if (env?.LanguageModel && typeof env.LanguageModel.create === 'function') {
    return { api: env.LanguageModel, variant: 'LanguageModel' };
  }
  if (env?.ai?.languageModel && typeof env.ai.languageModel.create === 'function') {
    return { api: env.ai.languageModel, variant: 'ai.languageModel' };
  }
  return null;
}

function normalizeAvailability(raw) {
  if (raw === 'readily' || raw === 'available') return 'available';
  if (raw === 'after-download' || raw === 'downloadable') return 'downloadable';
  if (raw === 'downloading') return 'downloading';
  return 'unavailable';
}

async function queryAvailability(api, variant, options) {
  if (typeof api.availability === 'function') {
    const res = await api.availability(options);
    return normalizeAvailability(res);
  }
  if (variant === 'ai.languageModel' && typeof api.capabilities === 'function') {
    const caps = await api.capabilities();
    return normalizeAvailability(caps?.available);
  }
  return 'available';
}

function isUnsupportedFeatureError(error) {
  const name = error?.name || '';
  const msg = String(error?.message || '').toLowerCase();
  return (
    name === 'NotSupportedError' ||
    name === 'TypeError' ||
    msg.includes('not supported') ||
    msg.includes('expectedinputs') ||
    msg.includes('multimodal') ||
    msg.includes('image') ||
    msg.includes('responseconstraint')
  );
}

/**
 * Wrapper around Chrome Built-in AI Prompt API (Gemini Nano).
 */
export class NanoClient {
  constructor(env = globalThis) {
    this.env = env;
    this.baseSession = null;
    this.multimodalEnabled = false;
    this.apiVariant = null;
    this.systemPrompt = SYSTEM_PROMPT;
  }

  async checkAvailability() {
    const found = getLanguageModelApi(this.env);
    if (!found) {
      return {
        supported: false,
        status: 'unavailable',
        multimodal: false,
        apiVariant: null,
        message: 'このブラウザまたは実行コンテキストでは Prompt API (LanguageModel) が利用できません。'
      };
    }

    const { api, variant } = found;
    this.apiVariant = variant;

    const multimodalOptions = {
      expectedInputs: [
        { type: 'text', languages: ['ja', 'en'] },
        { type: 'image' }
      ],
      expectedOutputs: [{ type: 'text', languages: ['ja'] }]
    };

    try {
      const mmStatus = await queryAvailability(api, variant, multimodalOptions);
      if (mmStatus !== 'unavailable') {
        return {
          supported: true,
          status: mmStatus,
          multimodal: true,
          apiVariant: variant,
          message:
            mmStatus === 'available'
              ? 'Gemini Nano（画像＋テキスト対応）が利用可能です。'
              : `Gemini Nano（画像＋テキスト対応）は ${mmStatus} 状態です。`
        };
      }
    } catch {
      // Fall through to text-only probe
    }

    try {
      const textStatus = await queryAvailability(api, variant, {
        expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
        expectedOutputs: [{ type: 'text', languages: ['ja'] }]
      });
      if (textStatus !== 'unavailable') {
        return {
          supported: true,
          status: textStatus,
          multimodal: false,
          apiVariant: variant,
          message:
            textStatus === 'available'
              ? 'Gemini Nano（テキスト専用モード）が利用可能です。'
              : `Gemini Nano（テキスト専用モード）は ${textStatus} 状態です。`
        };
      }
    } catch {
      // Try bare availability() without options as final fallback
      try {
        const bareStatus = await queryAvailability(api, variant, undefined);
        if (bareStatus !== 'unavailable') {
          return {
            supported: true,
            status: bareStatus,
            multimodal: false,
            apiVariant: variant,
            message: `Gemini Nano (${bareStatus}) が利用可能です。`
          };
        }
      } catch {
        // Ignore
      }
    }

    return {
      supported: true,
      status: 'unavailable',
      multimodal: false,
      apiVariant: variant,
      message: 'Gemini Nano モデルが利用不可状態です。chrome://flags の設定または端末要件を確認してください。'
    };
  }

  async initialize({ useVision = true, systemPrompt = SYSTEM_PROMPT, onDownloadProgress, signal } = {}) {
    const found = getLanguageModelApi(this.env);
    if (!found) {
      throw new Error('Prompt API (LanguageModel) が見つかりません。');
    }

    await this.destroy();
    const { api, variant } = found;
    this.apiVariant = variant;
    this.systemPrompt = systemPrompt;

    const createWithMonitor = (withImage) => {
      const options = {
        initialPrompts: [{ role: 'system', content: systemPrompt }]
      };
      if (signal) {
        options.signal = signal;
      }
      if (withImage) {
        options.expectedInputs = [
          { type: 'text', languages: ['ja', 'en'] },
          { type: 'image' }
        ];
        options.expectedOutputs = [{ type: 'text', languages: ['ja'] }];
      } else {
        options.expectedInputs = [{ type: 'text', languages: ['ja', 'en'] }];
        options.expectedOutputs = [{ type: 'text', languages: ['ja'] }];
      }
      if (typeof onDownloadProgress === 'function') {
        options.monitor = (m) => {
          m?.addEventListener?.('downloadprogress', (event) => {
            const loaded = Number(event?.loaded ?? 0);
            const total = Number(event?.total ?? 1);
            const ratio = total > 1 ? loaded / total : loaded;
            const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
            onDownloadProgress(percent, event);
          });
        };
      }
      return api.create(options);
    };

    if (useVision) {
      try {
        this.baseSession = await createWithMonitor(true);
        this.multimodalEnabled = true;
        return { multimodal: true, apiVariant: variant };
      } catch (error) {
        if (error?.name === 'AbortError' || !isUnsupportedFeatureError(error)) {
          throw error;
        }
      }
    }

    try {
      this.baseSession = await createWithMonitor(false);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // Fallback for older implementations without expectedInputs/expectedOutputs
      const minimalOptions = {
        systemPrompt,
        initialPrompts: [{ role: 'system', content: systemPrompt }]
      };
      if (signal) minimalOptions.signal = signal;
      this.baseSession = await api.create(minimalOptions);
    }

    this.multimodalEnabled = false;
    return { multimodal: false, apiVariant: variant };
  }

  async _createStepSession(signal) {
    if (!this.baseSession) {
      await this.initialize({ useVision: this.multimodalEnabled, systemPrompt: this.systemPrompt, signal });
    }
    if (typeof this.baseSession.clone === 'function') {
      try {
        return await this.baseSession.clone(signal ? { signal } : undefined);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
      }
    }

    const found = getLanguageModelApi(this.env);
    const options = {
      initialPrompts: [{ role: 'system', content: this.systemPrompt }]
    };
    if (this.multimodalEnabled) {
      options.expectedInputs = [
        { type: 'text', languages: ['ja', 'en'] },
        { type: 'image' }
      ];
    }
    if (signal) options.signal = signal;
    return found.api.create(options);
  }

  async decideAction({ promptText, image = null, signal } = {}) {
    const stepSession = await this._createStepSession(signal);
    const useImage = Boolean(image && this.multimodalEnabled);
    const payload = useImage
      ? [
          {
            role: 'user',
            content: [
              { type: 'text', value: promptText },
              { type: 'image', value: image }
            ]
          }
        ]
      : promptText;

    try {
      let rawText;
      let usedConstraint = true;
      try {
        const promptOptions = { responseConstraint: ACTION_RESPONSE_SCHEMA };
        if (signal) promptOptions.signal = signal;
        rawText = await stepSession.prompt(payload, promptOptions);
      } catch (error) {
        if (error?.name === 'AbortError' || !isUnsupportedFeatureError(error)) {
          throw error;
        }
        usedConstraint = false;
        rawText = await stepSession.prompt(payload, signal ? { signal } : undefined);
      }

      const action = parseActionResponse(rawText);
      const usage = {
        inputUsage: stepSession.inputUsage ?? null,
        inputQuota: stepSession.inputQuota ?? null,
        usedConstraint,
        usedVision: useImage
      };
      return { action, rawText, usage };
    } finally {
      try {
        stepSession?.destroy?.();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async destroy() {
    if (this.baseSession) {
      try {
        this.baseSession.destroy?.();
      } catch {
        // Ignore cleanup errors
      }
      this.baseSession = null;
    }
    this.multimodalEnabled = false;
  }
}
