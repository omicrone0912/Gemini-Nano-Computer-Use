import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentController } from '../shared/agent-controller.js';
import { EXECUTION_MODES } from '../shared/constants.js';

test('AgentController executes multi-step task until done', async () => {
  const executed = [];
  const events = [];
  let stepCount = 0;

  const mockNano = {
    async initialize() {
      return { multimodal: false, apiVariant: 'LanguageModel' };
    },
    async decideAction() {
      stepCount += 1;
      if (stepCount === 1) {
        return {
          action: { thought: '入力欄へ記入', action: 'type', elementId: 1, text: 'Chrome', clear: true },
          usage: {}
        };
      }
      return {
        action: { thought: '完了', action: 'done', message: '検索入力を完了しました。' },
        usage: {}
      };
    }
  };

  const controller = new AgentController({
    nanoClient: mockNano,
    async observe() {
      return {
        snapshot: {
          restricted: false,
          url: 'https://example.com',
          title: 'Example',
          elements: [{ id: 1, tag: 'input', inputType: 'text', label: '検索' }]
        },
        image: null
      };
    },
    async executeAction(action) {
      executed.push(action);
      return { ok: true, detail: 'ok' };
    },
    async requestConfirmation() {
      throw new Error('安全操作では確認モーダルを開かない想定');
    },
    onEvent(ev) {
      events.push(ev.type);
    }
  });

  const outcome = await controller.run({
    goal: '検索する',
    settings: { maxSteps: 5, executionMode: EXECUTION_MODES.AUTO_SAFE, actionDelayMs: 0 }
  });

  assert.equal(outcome.status, 'completed');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].action, 'type');
  assert.ok(events.includes('run_finished'));
});

test('AgentController requests confirmation for sensitive click and aborts when declined', async () => {
  let confirmCalls = 0;
  let executedCount = 0;

  const controller = new AgentController({
    nanoClient: {
      async initialize() {
        return { multimodal: false };
      },
      async decideAction() {
        return {
          action: { thought: '購入確定を押す', action: 'click', elementId: 1 },
          usage: {}
        };
      }
    },
    async observe() {
      return {
        snapshot: {
          restricted: false,
          url: 'https://shop.example.com',
          title: 'Checkout',
          elements: [{ id: 1, tag: 'button', label: '購入を確定する' }]
        }
      };
    },
    async executeAction() {
      executedCount += 1;
      return { ok: true };
    },
    async requestConfirmation() {
      confirmCalls += 1;
      return { approved: false, stop: true };
    }
  });

  const outcome = await controller.run({
    goal: '購入する',
    settings: { maxSteps: 3, executionMode: EXECUTION_MODES.AUTO_SAFE, actionDelayMs: 0 }
  });

  assert.equal(confirmCalls, 1);
  assert.equal(executedCount, 0);
  assert.equal(outcome.status, 'stopped');
});

test('AgentController stop() cancels an active run', async () => {
  let controller;
  controller = new AgentController({
    nanoClient: {
      async initialize() {
        return { multimodal: false };
      },
      async decideAction() {
        controller.stop();
        return { action: { thought: 'wait', action: 'wait', ms: 1000 }, usage: {} };
      }
    },
    async observe() {
      return { snapshot: { restricted: false, url: 'https://example.com', elements: [] } };
    },
    async executeAction() {
      return { ok: true };
    }
  });

  const outcome = await controller.run({
    goal: 'テスト',
    settings: { maxSteps: 5, actionDelayMs: 0 }
  });

  assert.equal(outcome.status, 'stopped');
});

test('AgentController passes pdfContext from observe to prompt and handles download_page_pdf', async () => {
  const promptsSeen = [];
  let step = 0;

  const controller = new AgentController({
    nanoClient: {
      async initialize() {
        return { multimodal: false };
      },
      async decideAction({ promptText }) {
        promptsSeen.push(promptText);
        step += 1;
        if (step === 1) {
          return { action: { thought: 'PDF保存', action: 'download_page_pdf' }, usage: {} };
        }
        return { action: { thought: '要約完了', action: 'done', message: 'PDFを確認しました' }, usage: {} };
      }
    },
    async observe() {
      return {
        snapshot: { restricted: false, url: 'https://example.com', title: 'Doc', elements: [] },
        pdfContext: step >= 1 ? { filename: 'Doc.pdf', pageCount: 1, currentPage: 1, currentPageText: '本文テスト' } : null
      };
    },
    async executeAction(action) {
      if (action.action === 'download_page_pdf') {
        return { ok: true, detail: '保存完了', promptNote: '保存済PDF Doc.pdf' };
      }
      return { ok: true };
    }
  });

  const outcome = await controller.run({
    goal: '画面をPDF保存して要約',
    settings: { maxSteps: 4, actionDelayMs: 0 }
  });

  assert.equal(outcome.status, 'completed');
  assert.equal(promptsSeen.length, 2);
  assert.match(promptsSeen[1], /Doc\.pdf/);
  assert.match(promptsSeen[1], /本文テスト/);
});

test('AgentController blocks multi-tab actions when allowMultiTab is false', async () => {
  let executedCount = 0;
  let step = 0;

  const controller = new AgentController({
    nanoClient: {
      async initialize() {
        return { multimodal: false };
      },
      async decideAction() {
        step += 1;
        if (step === 1) {
          return { action: { thought: '新タブ', action: 'open_tab', url: 'https://example.com' }, usage: {} };
        }
        return { action: { thought: '終了', action: 'done', message: '完了' }, usage: {} };
      }
    },
    async observe() {
      return { snapshot: { restricted: false, url: 'https://example.com', elements: [] } };
    },
    async executeAction() {
      executedCount += 1;
      return { ok: true };
    }
  });

  const outcome = await controller.run({
    goal: 'テスト',
    settings: { maxSteps: 3, allowMultiTab: false, actionDelayMs: 0 }
  });

  assert.equal(outcome.status, 'completed');
  assert.equal(executedCount, 0);
  assert.equal(outcome.history[0].result.blocked, true);
});

test('AgentController passes playbookContext from observe to buildStepPrompt', async () => {
  const promptsSeen = [];
  const controller = new AgentController({
    nanoClient: {
      async initialize() {
        return { multimodal: false };
      },
      async decideAction({ promptText }) {
        promptsSeen.push(promptText);
        return { action: { thought: '完了', action: 'done', message: '手順書通り完了' }, usage: {} };
      }
    },
    async observe() {
      return {
        snapshot: { restricted: false, url: 'https://example.com', elements: [] },
        playbookContext: {
          title: '申請手順',
          filename: 'apply.md',
          rawText: '## 実行ステップ\n1. [done] 完了する'
        }
      };
    },
    async executeAction() {
      return { ok: true };
    }
  });

  const outcome = await controller.run({
    goal: '手順書実行',
    settings: { maxSteps: 2, actionDelayMs: 0 }
  });

  assert.equal(outcome.status, 'completed');
  assert.match(promptsSeen[0], /# 適用中の手順書 \(申請手順\)/);
});

test('AgentController escalates to ask_user confirmation when action fails under strict playbook', async () => {
  let confirmDetails = null;
  let step = 0;

  const controller = new AgentController({
    nanoClient: {
      async initialize() {
        return { multimodal: true };
      },
      async decideAction() {
        step += 1;
        if (step === 1) {
          return { action: { thought: 'ボタン押下', action: 'click', elementId: 99 }, usage: {} };
        }
        return { action: { thought: '完了', action: 'done', message: '人間指示後に完了' }, usage: {} };
      }
    },
    async observe() {
      return {
        snapshot: { restricted: false, url: 'https://example.com', elements: [] },
        playbookContext: {
          title: '厳格手順',
          filename: 'strict.docx',
          strictMode: true,
          rawText: '## 実行ステップ\n1. [click] ボタン押下',
          images: [{ index: 1, name: 'btn.png', dataUrl: 'data:image/png;base64,AA==', stepHint: '1. [click]' }]
        }
      };
    },
    async executeAction() {
      return { ok: false, error: '要素 #99 が見つかりません' };
    },
    async requestConfirmation(details) {
      confirmDetails = details;
      return { approved: true, userReply: '手動で修正したので続行してください' };
    }
  });

  const outcome = await controller.run({
    goal: '手順書通り実行',
    settings: { maxSteps: 3, actionDelayMs: 0 }
  });

  assert.equal(outcome.status, 'completed');
  assert.equal(confirmDetails.kind, 'ask_user');
  assert.match(confirmDetails.reason, /失敗しました/);
});

test('AgentController runs without a maxSteps cap until done even beyond 15 steps', async () => {
  let stepCount = 0;
  const stepStartedEvents = [];

  const controller = new AgentController({
    nanoClient: {
      async initialize() {
        return { multimodal: false };
      },
      async decideAction() {
        stepCount += 1;
        if (stepCount < 25) {
          return {
            action: { thought: `step ${stepCount}`, action: 'scroll', direction: 'down' },
            usage: {}
          };
        }
        return {
          action: { thought: '完了', action: 'done', message: '25ステップで完了しました' },
          usage: {}
        };
      }
    },
    async observe() {
      return {
        snapshot: { restricted: false, url: 'https://example.com', elements: [] }
      };
    },
    async executeAction() {
      return { ok: true, detail: 'scrolled' };
    },
    onEvent(ev) {
      if (ev.type === 'step_started') {
        stepStartedEvents.push(ev);
      }
    }
  });

  const outcome = await controller.run({
    goal: '最後まで実行する',
    settings: { maxSteps: 5, actionDelayMs: 0 }
  });

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.history.length, 25);
  assert.equal(stepStartedEvents.length, 25);
  assert.equal('maxSteps' in stepStartedEvents[0], false);
  assert.equal(stepStartedEvents.at(-1).step, 25);
});

test('AgentController AUTO_ALL mode auto-approves sensitive actions, ask_user, and strict playbook failures without prompting', async () => {
  let confirmCalls = 0;
  let stepCount = 0;
  const executed = [];

  const controller = new AgentController({
    nanoClient: {
      async initialize() {
        return { multimodal: false };
      },
      async decideAction() {
        stepCount += 1;
        if (stepCount === 1) {
          return { action: { thought: '質問', action: 'ask_user', message: '続行してよいですか？' }, usage: {} };
        }
        if (stepCount === 2) {
          return { action: { thought: '購入確定', action: 'click', elementId: 1 }, usage: {} };
        }
        if (stepCount === 3) {
          return { action: { thought: 'エラーテスト', action: 'click', elementId: 2 }, usage: {} };
        }
        if (stepCount === 4) {
          return {
            action: { thought: '危険スキーム', action: 'navigate', url: 'javascript:alert(1)' },
            usage: {}
          };
        }
        return { action: { thought: '完了', action: 'done', message: '全自動で完了しました' }, usage: {} };
      }
    },
    async observe() {
      return {
        snapshot: {
          restricted: false,
          url: 'https://shop.example.com',
          title: 'Checkout',
          elements: [
            { id: 1, tag: 'button', label: '購入を確定する' },
            { id: 2, tag: 'button', label: '次へ' }
          ]
        },
        playbookContext: {
          title: '厳格手順',
          filename: 'strict.md',
          strictMode: true,
          rawText: '## 実行ステップ\n1. [click] 購入を確定する'
        }
      };
    },
    async executeAction(action) {
      executed.push(action);
      if (action.elementId === 2) {
        return { ok: false, error: '一時エラー' };
      }
      return { ok: true, detail: 'ok' };
    },
    async requestConfirmation() {
      confirmCalls += 1;
      return { approved: false, stop: true };
    }
  });

  const outcome = await controller.run({
    goal: '全自動で購入フローを完了する',
    settings: { executionMode: EXECUTION_MODES.AUTO_ALL, actionDelayMs: 0 }
  });

  assert.equal(confirmCalls, 0);
  assert.equal(outcome.status, 'completed');
  assert.equal(executed.length, 2);
  assert.equal(executed[0].elementId, 1);
  assert.equal(outcome.history[0].result.autoApproved, true);
  assert.equal(outcome.history[3].result.blocked, true);
});
