import { ACTION_RESPONSE_SCHEMA, parseActionResponse } from './action-schema.js';
import { uint8ArrayToBase64 } from './pdf-parser.js';
import { SYSTEM_PROMPT } from './prompt-builder.js';

export const QWEN_DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
export const QWEN_DEFAULT_MODEL = 'qwen2.5vl:3b';

export const QWEN_MODEL_OPTIONS = Object.freeze([
  { value: 'qwen2.5vl:3b', label: 'Qwen 2.5 VL 3B（軽量・推奨 約3.2GB）' },
  { value: 'qwen2.5vl:7b', label: 'Qwen 2.5 VL 7B（高精度 約6.0GB）' }
]);

export function validateLocalOllamaEndpoint(rawUrl = QWEN_DEFAULT_ENDPOINT) {
  const input = String(rawUrl || '').trim() || QWEN_DEFAULT_ENDPOINT;
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('有効なローカル接続先 URL を指定してください。');
  }
  if (parsed.protocol !== 'http:') {
    throw new Error('ローカル Ollama 接続は http://127.0.0.1 または http://localhost のみ許可されています。');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('セキュリティのため、外部サーバーではなくローカル (127.0.0.1 / localhost) のみ接続できます。');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function generateQwenWindowsInstallerBat(model = QWEN_DEFAULT_MODEL) {
  const safeModel = QWEN_MODEL_OPTIONS.some((m) => m.value === model) ? model : QWEN_DEFAULT_MODEL;
  const lines = [
    '@echo off',
    'setlocal EnableExtensions',
    'title Gemini Nano Computer Use - Qwen 2.5 VL 1-Step Installer',
    'echo ============================================================',
    'echo  Qwen 2.5 VL (Ollama) 1-Step Setup for Chrome Extension',
    `echo  Target Model: ${safeModel}`,
    'echo ============================================================',
    'echo.',
    'set "OLLAMA_EXE=ollama"',
    'where ollama >nul 2>&1',
    'if errorlevel 1 (',
    '  if exist "%LocalAppData%\\Programs\\Ollama\\ollama.exe" (',
    '    set "OLLAMA_EXE=%LocalAppData%\\Programs\\Ollama\\ollama.exe"',
    '  )',
    ')',
    'if "%OLLAMA_EXE%"=="ollama" (',
    '  where ollama >nul 2>&1',
    '  if errorlevel 1 (',
    '    echo [1/4] Installing Ollama locally...',
    '    where winget >nul 2>&1',
    '    if not errorlevel 1 (',
    '      winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements --silent',
    '    )',
    '    if exist "%LocalAppData%\\Programs\\Ollama\\ollama.exe" (',
    '      set "OLLAMA_EXE=%LocalAppData%\\Programs\\Ollama\\ollama.exe"',
    '    ) else (',
    '      echo Downloading official OllamaSetup.exe...',
    '      powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri https://ollama.com/download/OllamaSetup.exe -OutFile ($env:TEMP + \'\\OllamaSetup.exe\')"',
    '      "%TEMP%\\OllamaSetup.exe" /VERYSILENT /NORESTART',
    '      if exist "%LocalAppData%\\Programs\\Ollama\\ollama.exe" set "OLLAMA_EXE=%LocalAppData%\\Programs\\Ollama\\ollama.exe"',
    '    )',
    '  ) else (',
    '    echo [1/4] Ollama is already installed.',
    '  )',
    ') else (',
    '  echo [1/4] Ollama is already installed.',
    ')',
    'echo [2/4] Allowing Chrome extension origin (OLLAMA_ORIGINS)...',
    'setx OLLAMA_ORIGINS "chrome-extension://*,http://localhost:*,http://127.0.0.1:*" >nul',
    'set "OLLAMA_ORIGINS=chrome-extension://*,http://localhost:*,http://127.0.0.1:*"',
    'echo [3/4] Restarting local Ollama service...',
    'taskkill /IM ollama.exe /F >nul 2>&1',
    'taskkill /IM "ollama app.exe" /F >nul 2>&1',
    'timeout /t 2 /nobreak >nul',
    'start "" "%OLLAMA_EXE%" serve',
    'timeout /t 4 /nobreak >nul',
    `echo [4/4] Downloading ${safeModel} (this may take a few minutes)...`,
    `"%OLLAMA_EXE%" pull ${safeModel}`,
    'if errorlevel 1 (',
    '  echo.',
    '  echo [ERROR] Model download failed. Make sure internet connection is active and try again.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo.',
    'echo ============================================================',
    `echo  Setup Complete! ${safeModel} is ready.`,
    'echo  Return to Chrome side panel and click "再確認" (or wait 4s).',
    'echo ============================================================',
    'pause'
  ];
  return lines.join('\r\n') + '\r\n';
}

export function generateQwenPowerShellOneLiner(model = QWEN_DEFAULT_MODEL) {
  const safeModel = QWEN_MODEL_OPTIONS.some((m) => m.value === model) ? model : QWEN_DEFAULT_MODEL;
  return [
    'if (!(Get-Command ollama -ErrorAction SilentlyContinue)) {',
    '  winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements --silent',
    '};',
    '$env:OLLAMA_ORIGINS="chrome-extension://*,http://localhost:*,http://127.0.0.1:*";',
    '[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS",$env:OLLAMA_ORIGINS,"User");',
    'Get-Process ollama* -ErrorAction SilentlyContinue | Stop-Process -Force;',
    'Start-Sleep -Seconds 2;',
    '$exe=(Get-Command ollama -ErrorAction SilentlyContinue).Source; if(!$exe){$exe="$env:LocalAppData\\Programs\\Ollama\\ollama.exe"};',
    'Start-Process $exe -ArgumentList "serve" -WindowStyle Hidden;',
    'Start-Sleep -Seconds 3;',
    `& $exe pull ${safeModel}`
  ].join(' ');
}

function stripDataUrlPrefix(dataUrl = '') {
  return String(dataUrl || '').replace(/^data:[^;]+;base64,/i, '');
}

async function imageInputToBase64(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    return stripDataUrlPrefix(value);
  }
  if (value instanceof Uint8Array) {
    return uint8ArrayToBase64(value);
  }
  if (typeof value.arrayBuffer === 'function') {
    const buf = await value.arrayBuffer();
    return uint8ArrayToBase64(new Uint8Array(buf));
  }
  return '';
}

function modelMatchesTag(installedName = '', targetModel = '') {
  const installed = String(installedName || '').toLowerCase();
  const target = String(targetModel || '').toLowerCase();
  if (!installed || !target) return false;
  if (installed === target) return true;
  if (!target.includes(':') && installed === `${target}:latest`) return true;
  return false;
}

/**
 * Local Qwen 2.5 VL client backed by loopback Ollama (`http://127.0.0.1:11434`).
 * Mirrors NanoClient's interface (`checkAvailability`, `initialize`, `decideAction`, `destroy`).
 */
export class QwenLocalClient {
  constructor({
    endpoint = QWEN_DEFAULT_ENDPOINT,
    model = QWEN_DEFAULT_MODEL,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.endpoint = validateLocalOllamaEndpoint(endpoint);
    this.model = String(model || QWEN_DEFAULT_MODEL);
    this.fetch = typeof fetchImpl === 'function' ? fetchImpl.bind(globalThis) : null;
    this.systemPrompt = SYSTEM_PROMPT;
    this.multimodalEnabled = true;
    this.apiVariant = 'OllamaQwen25VL';
    this.activeAbortController = null;
  }

  configure({ endpoint, model } = {}) {
    if (endpoint !== undefined) {
      this.endpoint = validateLocalOllamaEndpoint(endpoint);
    }
    if (model !== undefined && model) {
      this.model = String(model);
    }
  }

  async checkAvailability({ signal } = {}) {
    if (!this.fetch) {
      return {
        supported: false,
        status: 'needs_ollama',
        multimodal: false,
        model: this.model,
        message: 'この環境ではローカル通信 (fetch) が利用できません。'
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onExternalAbort, { once: true });

    try {
      const resp = await this.fetch(`${this.endpoint}/api/tags`, {
        method: 'GET',
        signal: controller.signal
      });

      if (resp.status === 403) {
        return {
          supported: true,
          status: 'cors_blocked',
          multimodal: true,
          model: this.model,
          message: 'Ollama は起動していますが、Chrome 拡張からのアクセス許可 (OLLAMA_ORIGINS) が未設定です。「1ステップ導入」から設定してください。'
        };
      }

      if (!resp.ok) {
        return {
          supported: true,
          status: 'needs_ollama',
          multimodal: false,
          model: this.model,
          message: `ローカル Ollama からエラー応答 (${resp.status}) が返りました。`
        };
      }

      const data = await resp.json();
      const models = Array.isArray(data?.models) ? data.models : [];
      const installed = models.some((m) => modelMatchesTag(m?.name || m?.model, this.model));

      if (installed) {
        return {
          supported: true,
          status: 'available',
          multimodal: true,
          model: this.model,
          installedModels: models.map((m) => m?.name).filter(Boolean),
          message: `Qwen 2.5 VL (${this.model}) が利用可能です。`
        };
      }

      return {
        supported: true,
        status: 'downloadable',
        multimodal: true,
        model: this.model,
        installedModels: models.map((m) => m?.name).filter(Boolean),
        message: `Ollama 起動中 — 「${this.model}」を1クリックでインストールできます。`
      };
    } catch {
      return {
        supported: true,
        status: 'needs_ollama',
        multimodal: false,
        model: this.model,
        message: 'ローカル Ollama が見つかりません。「1ステップ導入」で Ollama と Qwen 2.5 VL をまとめて導入できます。'
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onExternalAbort);
    }
  }

  async installModel({ model = this.model, onDownloadProgress, signal } = {}) {
    if (!this.fetch) {
      throw new Error('fetch が利用できないためモデルをインストールできません。');
    }
    const targetModel = String(model || this.model);
    this.model = targetModel;

    const resp = await this.fetch(`${this.endpoint}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: targetModel, stream: true }),
      signal
    });

    if (resp.status === 403) {
      throw new Error('Ollama が Chrome 拡張からの接続を拒否しました (403)。「1ステップ導入」または OLLAMA_ORIGINS の設定を行ってください。');
    }
    if (!resp.ok) {
      throw new Error(`モデルダウンロードに失敗しました (HTTP ${resp.status})。`);
    }

    if (!resp.body || typeof resp.body.getReader !== 'function') {
      const text = await resp.text();
      if (text.includes('"error"')) {
        throw new Error(text);
      }
      onDownloadProgress?.(100, 'インストール完了');
      return { ok: true, model: targetModel };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastPercent = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (parsed.error) {
          throw new Error(parsed.error);
        }
        if (Number.isFinite(parsed.total) && parsed.total > 0 && Number.isFinite(parsed.completed)) {
          lastPercent = Math.max(0, Math.min(99, Math.round((parsed.completed / parsed.total) * 100)));
        } else if (parsed.status === 'success') {
          lastPercent = 100;
        }
        onDownloadProgress?.(lastPercent, parsed.status || '');
      }
    }

    if (buffer.trim()) {
      try {
        const last = JSON.parse(buffer.trim());
        if (last.error) throw new Error(last.error);
      } catch (err) {
        if (err instanceof Error && !err.message.includes('JSON')) throw err;
      }
    }

    onDownloadProgress?.(100, 'success');
    return { ok: true, model: targetModel };
  }

  async initialize({ useVision = true, systemPrompt = SYSTEM_PROMPT, onDownloadProgress, signal } = {}) {
    this.systemPrompt = systemPrompt || SYSTEM_PROMPT;
    this.multimodalEnabled = Boolean(useVision);

    const status = await this.checkAvailability({ signal });
    if (status.status === 'needs_ollama' || status.status === 'cors_blocked') {
      throw new Error(status.message);
    }
    if (status.status === 'downloadable') {
      await this.installModel({ model: this.model, onDownloadProgress, signal });
    }

    return {
      multimodal: this.multimodalEnabled,
      apiVariant: this.apiVariant,
      model: this.model
    };
  }

  async decideAction({ promptText, image = null, referenceImages = [], signal } = {}) {
    if (!this.fetch) {
      throw new Error('fetch が利用できません。');
    }

    this.activeAbortController?.abort();
    const controller = new AbortController();
    this.activeAbortController = controller;
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const useImage = Boolean(image && this.multimodalEnabled);
    const mainImgBase64 = useImage ? await imageInputToBase64(image) : '';
    const refImgList = [];

    if (this.multimodalEnabled && Array.isArray(referenceImages)) {
      for (const ref of referenceImages) {
        const b64 = await imageInputToBase64(ref?.blob || ref?.value || ref?.dataUrl);
        if (b64) {
          refImgList.push({
            index: ref.index ?? refImgList.length + 1,
            name: ref.name || `image-${refImgList.length + 1}`,
            stepHint: ref.stepHint || '',
            base64: b64
          });
        }
      }
    }

    const buildBody = ({ includeMain, includeRefs, format }) => {
      const images = [];
      let content = promptText;
      if (includeMain && mainImgBase64) {
        images.push(mainImgBase64);
      }
      if (includeRefs && refImgList.length > 0) {
        const notes = refImgList
          .map((r) => `・画像#${images.push(r.base64)}: 手順書画像「${r.name}」${r.stepHint ? ` (${r.stepHint})` : ''}`)
          .join('\n');
        content = `${content}\n\n【添付画像対応表】\n${includeMain && mainImgBase64 ? '・画像#1: 現在のブラウザ画面スクリーンショット\n' : ''}${notes}`;
      }

      const userMsg = { role: 'user', content };
      if (images.length > 0) {
        userMsg.images = images;
      }

      return {
        model: this.model,
        stream: false,
        format,
        options: { temperature: 0.1 },
        messages: [
          { role: 'system', content: this.systemPrompt },
          userMsg
        ]
      };
    };

    const callChat = async (body) => {
      const resp = await this.fetch(`${this.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const err = new Error(`Ollama API エラー (${resp.status}): ${errText || resp.statusText}`);
        err.status = resp.status;
        throw err;
      }
      const data = await resp.json();
      return String(data?.message?.content || data?.response || '');
    };

    try {
      let rawText;
      let usedConstraint = true;
      let usedVision = Boolean(mainImgBase64 || refImgList.length > 0);

      try {
        rawText = await callChat(
          buildBody({
            includeMain: Boolean(mainImgBase64),
            includeRefs: refImgList.length > 0,
            format: ACTION_RESPONSE_SCHEMA
          })
        );
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        // Fallback 1: plain `format: "json"` instead of full JSON schema object
        try {
          usedConstraint = false;
          rawText = await callChat(
            buildBody({
              includeMain: Boolean(mainImgBase64),
              includeRefs: refImgList.length > 0,
              format: 'json'
            })
          );
        } catch (err2) {
          if (err2?.name === 'AbortError' || signal?.aborted) throw err2;
          // Fallback 2: drop reference images, keep main screenshot
          if (mainImgBase64 && refImgList.length > 0) {
            try {
              rawText = await callChat(
                buildBody({ includeMain: true, includeRefs: false, format: 'json' })
              );
              usedVision = true;
            } catch (err3) {
              if (err3?.name === 'AbortError' || signal?.aborted) throw err3;
              usedVision = false;
              rawText = await callChat(
                buildBody({ includeMain: false, includeRefs: false, format: 'json' })
              );
            }
          } else if (usedVision) {
            usedVision = false;
            rawText = await callChat(
              buildBody({ includeMain: false, includeRefs: false, format: 'json' })
            );
          } else {
            throw err2;
          }
        }
      }

      const action = parseActionResponse(rawText);
      return {
        action,
        rawText,
        usage: {
          inputUsage: null,
          inputQuota: null,
          usedConstraint,
          usedVision,
          provider: 'qwen2.5-vl'
        }
      };
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
    }
  }

  async destroy() {
    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort();
      } catch {
        // Ignore
      }
      this.activeAbortController = null;
    }
  }
}
