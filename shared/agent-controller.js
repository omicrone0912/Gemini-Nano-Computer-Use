import { DEFAULT_SETTINGS, EXECUTION_MODES } from './constants.js';
import { buildStepPrompt, SYSTEM_PROMPT } from './prompt-builder.js';
import { assessActionRisk, detectActionLoop } from './safety.js';

function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function summarizeAction(action) {
  if (!action) return '';
  switch (action.action) {
    case 'click':
      return `要素 #${action.elementId} をクリック`;
    case 'type':
      return `要素 #${action.elementId} に "${action.text}" を入力`;
    case 'select':
      return `要素 #${action.elementId} で "${action.text}" を選択`;
    case 'press_key':
      return `キー "${action.key}" を押下`;
    case 'scroll':
      return `画面を ${action.direction} へスクロール`;
    case 'navigate':
      return `${action.url} へ移動`;
    case 'go_back':
      return '前のページへ戻る';
    case 'go_forward':
      return '次のページへ進む';
    case 'wait':
      return `${action.ms}ms 待機`;
    case 'ask_user':
      return `ユーザー確認: ${action.message}`;
    case 'done':
      return `完了: ${action.message}`;
    default:
      return action.action;
  }
}

/**
 * Orchestrates the Observe -> Think -> Guard -> Act loop.
 * Pure orchestration with dependency injection for easy unit testing.
 */
export class AgentController {
  constructor({ nanoClient, observe, executeAction, requestConfirmation, onEvent }) {
    this.nanoClient = nanoClient;
    this.observe = observe;
    this.executeAction = executeAction;
    this.requestConfirmation = requestConfirmation;
    this.onEvent = onEvent ?? (() => {});
    this.abortController = null;
    this.running = false;
    this.pendingConfirmationReject = null;
  }

  emit(type, payload = {}) {
    this.onEvent({ type, timestamp: Date.now(), ...payload });
  }

  stop() {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    if (this.pendingConfirmationReject) {
      const err = new Error('ユーザーによって停止されました。');
      err.name = 'AbortError';
      this.pendingConfirmationReject(err);
      this.pendingConfirmationReject = null;
    }
  }

  async _confirm(details, signal) {
    if (typeof this.requestConfirmation !== 'function') {
      return { approved: false, skip: false, stop: true };
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      this.pendingConfirmationReject = reject;
      this.requestConfirmation(details)
        .then((res) => {
          this.pendingConfirmationReject = null;
          resolve(res);
        })
        .catch((err) => {
          this.pendingConfirmationReject = null;
          reject(err);
        });
    });
  }

  async run({ goal, settings = {} }) {
    if (this.running) {
      throw new Error('エージェントはすでに実行中です。');
    }
    if (!goal || !goal.trim()) {
      throw new Error('実行するタスクを入力してください。');
    }

    const merged = { ...DEFAULT_SETTINGS, ...settings };
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    this.running = true;

    const history = [];
    let currentGoal = goal.trim();
    let loopWarning = '';
    let finalOutcome = { status: 'max_steps', message: '最大ステップ数に達したため終了しました。', history };

    try {
      this.emit('run_started', { goal: currentGoal, settings: merged });

      const initResult = await this.nanoClient.initialize({
        useVision: merged.useVision,
        systemPrompt: SYSTEM_PROMPT,
        signal,
        onDownloadProgress: (percent) => {
          this.emit('model_download_progress', { percent });
        }
      });

      this.emit('session_ready', {
        multimodal: initResult.multimodal,
        apiVariant: initResult.apiVariant
      });

      for (let step = 1; step <= merged.maxSteps; step += 1) {
        if (signal.aborted) {
          finalOutcome = { status: 'stopped', message: 'ユーザーによって中断されました。', history };
          break;
        }

        const stepStart = Date.now();
        this.emit('step_started', { step, maxSteps: merged.maxSteps });

        // 1. Observe
        const observation = await this.observe({
          useVision: merged.useVision && initResult.multimodal,
          maxElements: merged.maxElements,
          maxImageWidth: merged.maxImageWidth,
          signal
        });

        const snapshot = observation?.snapshot ?? { restricted: true, url: '', title: '', elements: [] };
        const image = observation?.image ?? null;

        this.emit('observation_captured', {
          step,
          snapshot,
          previewDataUrl: observation?.previewDataUrl ?? null,
          hasImage: Boolean(image)
        });

        if (signal.aborted) {
          finalOutcome = { status: 'stopped', message: 'ユーザーによって中断されました。', history };
          break;
        }

        // 2. Think
        const promptText = buildStepPrompt({
          goal: currentGoal,
          snapshot,
          history,
          stepIndex: step,
          maxSteps: merged.maxSteps,
          hasImage: Boolean(image && initResult.multimodal),
          loopWarning
        });
        loopWarning = '';

        let decision;
        try {
          decision = await this.nanoClient.decideAction({
            promptText,
            image: initResult.multimodal ? image : null,
            signal
          });
        } catch (error) {
          if (error?.name === 'AbortError' || signal.aborted) {
            finalOutcome = { status: 'stopped', message: 'ユーザーによって中断されました。', history };
            break;
          }
          const errMsg = error?.message || String(error);
          this.emit('step_error', { step, error: errMsg, durationMs: Date.now() - stepStart });
          history.push({
            step,
            action: { action: 'parse_error', thought: errMsg },
            result: { ok: false, error: errMsg }
          });
          loopWarning = `前回の出力が不正でした（${errMsg}）。必ず仕様通りの JSON のみを返してください。`;
          continue;
        }

        const { action, usage } = decision;
        this.emit('action_planned', {
          step,
          action,
          summary: summarizeAction(action),
          usage
        });

        // Terminal action: done
        if (action.action === 'done') {
          history.push({ step, action, result: { ok: true, done: true } });
          this.emit('step_completed', {
            step,
            action,
            result: { ok: true, done: true },
            durationMs: Date.now() - stepStart
          });
          finalOutcome = {
            status: 'completed',
            message: action.message || 'タスクが完了しました。',
            history
          };
          break;
        }

        // Interactive user question: ask_user
        if (action.action === 'ask_user') {
          const response = await this._confirm(
            {
              step,
              kind: 'ask_user',
              title: 'AI からの確認・質問',
              reason: action.message,
              action,
              allowCustomReply: true
            },
            signal
          );
          if (!response?.approved || response?.stop) {
            finalOutcome = { status: 'stopped', message: '確認画面で中断されました。', history };
            break;
          }
          if (response.userReply && response.userReply.trim()) {
            currentGoal = `${currentGoal}\n\n[ユーザーからの追加回答]: ${response.userReply.trim()}`;
          }
          history.push({
            step,
            action,
            result: { ok: true, userReply: response.userReply || '続行許可' }
          });
          this.emit('step_completed', {
            step,
            action,
            result: { ok: true },
            durationMs: Date.now() - stepStart
          });
          continue;
        }

        // 3. Safety & Loop check
        const risk = assessActionRisk(action, snapshot);
        if (risk.level === 'blocked') {
          const blockResult = { ok: false, blocked: true, error: risk.reason };
          history.push({ step, action, result: blockResult });
          loopWarning = `直前の操作 (${action.action}) は安全制限でブロックされました: ${risk.reason}`;
          this.emit('step_completed', {
            step,
            action,
            result: blockResult,
            durationMs: Date.now() - stepStart
          });
          continue;
        }

        if (risk.normalizedUrl) {
          action.url = risk.normalizedUrl;
        }

        if (detectActionLoop(history, action, 3)) {
          loopWarning =
            '直近で同じ操作が連続しており画面が進展していません。別の要素、スクロール、または別URLを試してください。';
        }

        const needsConfirmation =
          risk.level === 'confirm' || merged.executionMode === EXECUTION_MODES.STEP_BY_STEP;

        if (needsConfirmation) {
          const decisionConfirm = await this._confirm(
            {
              step,
              kind: risk.level === 'confirm' ? 'danger' : 'step',
              title: risk.level === 'confirm' ? '安全確認が必要です' : `ステップ ${step} の実行確認`,
              reason: risk.reason || summarizeAction(action),
              action,
              allowCustomReply: false
            },
            signal
          );

          if (decisionConfirm?.stop) {
            finalOutcome = { status: 'stopped', message: 'ユーザーによって中断されました。', history };
            break;
          }
          if (decisionConfirm?.skip) {
            const skipResult = { ok: false, skipped: true, error: 'ユーザーが操作をスキップしました。' };
            history.push({ step, action, result: skipResult });
            loopWarning = '直前の提案操作はユーザーによりスキップされました。別の方法を検討してください。';
            this.emit('step_completed', {
              step,
              action,
              result: skipResult,
              durationMs: Date.now() - stepStart
            });
            continue;
          }
          if (!decisionConfirm?.approved) {
            finalOutcome = { status: 'stopped', message: '操作が許可されなかったため中断しました。', history };
            break;
          }
        }

        // 4. Act
        let execResult;
        try {
          execResult = await this.executeAction(action, snapshot, signal);
        } catch (error) {
          if (error?.name === 'AbortError' || signal.aborted) {
            finalOutcome = { status: 'stopped', message: 'ユーザーによって中断されました。', history };
            break;
          }
          execResult = { ok: false, error: error?.message || String(error) };
        }

        history.push({ step, action, result: execResult });
        this.emit('step_completed', {
          step,
          action,
          result: execResult,
          durationMs: Date.now() - stepStart
        });

        if (!execResult?.ok && execResult?.error) {
          loopWarning = `直前の操作 (${summarizeAction(action)}) が失敗しました: ${execResult.error}`;
        }

        // 5. Wait between steps for DOM stabilization
        if (action.action !== 'wait' && merged.actionDelayMs > 0) {
          await sleep(merged.actionDelayMs, signal);
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError' || signal.aborted) {
        finalOutcome = { status: 'stopped', message: 'ユーザーによって中断されました。', history };
      } else {
        finalOutcome = {
          status: 'error',
          message: error?.message || '予期しないエラーが発生しました。',
          history
        };
      }
    } finally {
      this.running = false;
      this.abortController = null;
      this.pendingConfirmationReject = null;
      this.emit('run_finished', finalOutcome);
    }

    return finalOutcome;
  }
}
