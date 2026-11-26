import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStepPrompt } from '../shared/prompt-builder.js';

test('buildStepPrompt includes formatted elements, masked password, and image hint', () => {
  const prompt = buildStepPrompt({
    goal: '検索する',
    stepIndex: 2,
    maxSteps: 10,
    hasImage: true,
    loopWarning: '同じ操作を繰り返さないでください',
    snapshot: {
      restricted: false,
      url: 'https://example.com',
      title: 'Example Page',
      scroll: { x: 0, y: 120, maxY: 800 },
      elements: [
        { id: 1, tag: 'input', inputType: 'text', label: '検索', value: 'AI' },
        { id: 2, tag: 'input', inputType: 'password', label: 'PW', value: 'hunter2' },
        { id: 3, tag: 'button', label: '送信' }
      ],
      textExcerpt: 'テストページ本文'
    },
    history: [
      { step: 1, action: { action: 'type', elementId: 1, text: 'AI' }, result: { ok: true } }
    ]
  });

  assert.match(prompt, /赤枠番号バッジ/);
  assert.match(prompt, /\[1\] input type=text "検索" value="AI"/);
  assert.match(prompt, /\[2\] input type=password "PW" value="\*\*\*"/);
  assert.match(prompt, /同じ操作を繰り返さないでください/);
  assert.match(prompt, /Step 1: type #1/);
});

test('buildStepPrompt guides navigation on restricted pages', () => {
  const prompt = buildStepPrompt({
    goal: 'ニュースを見る',
    snapshot: { restricted: true, url: 'chrome://newtab/', title: '新しいタブ', elements: [] }
  });

  assert.match(prompt, /Chrome の保護領域/);
  assert.match(prompt, /navigate/);
});

test('buildStepPrompt includes loaded PDF context when present', () => {
  const prompt = buildStepPrompt({
    goal: 'PDFを要約する',
    snapshot: { restricted: false, url: 'https://example.com', title: 'Example', elements: [] },
    pdfContext: {
      filename: 'spec.pdf',
      pageCount: 5,
      currentPage: 2,
      currentPageText: '第2章: ローカルPDF解析の仕様'
    }
  });

  assert.match(prompt, /# 読み込み中の PDF/);
  assert.match(prompt, /spec\.pdf/);
  assert.match(prompt, /ページ: 2 \/ 5/);
  assert.match(prompt, /ローカルPDF解析の仕様/);
});

test('buildStepPrompt includes workspace tab group context when multiTabEnabled', () => {
  const prompt = buildStepPrompt({
    goal: '2つのタブを比較する',
    snapshot: { restricted: false, url: 'https://b.example', title: 'Site B', elements: [] },
    workspaceContext: {
      multiTabEnabled: true,
      backgroundMode: true,
      groupTitle: 'Nano AI',
      tabs: [
        { index: 1, title: 'Site A', url: 'https://a.example', isCurrent: false },
        { index: 2, title: 'Site B', url: 'https://b.example', isCurrent: true }
      ]
    }
  });

  assert.match(prompt, /# ワークスペースのタブ一覧/);
  assert.match(prompt, /Nano AI/);
  assert.match(prompt, /\[2\] \(操作中\) Site B/);
});

test('buildStepPrompt includes uploaded playbook context when present', () => {
  const prompt = buildStepPrompt({
    goal: '手順書を実行',
    snapshot: { restricted: false, url: 'https://example.com', title: 'Top', elements: [] },
    playbookContext: {
      title: 'テスト手順書',
      filename: 'test-sop.md',
      rawText: '## 実行ステップ\n1. [click] ログインを押す'
    },
    referenceImages: [{ index: 1, name: 'login.png', stepHint: '1. [click]' }]
  });

  assert.match(prompt, /# 適用中の手順書 \(テスト手順書\)/);
  assert.match(prompt, /厳格手順書モード/);
  assert.match(prompt, /ask_user/);
  assert.match(prompt, /\[添付画像 #1: login\.png\]/);
  assert.match(prompt, /1\. \[click\] ログインを押す/);
});
