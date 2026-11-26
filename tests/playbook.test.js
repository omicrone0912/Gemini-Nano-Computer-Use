import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYBOOK_TEMPLATE_FILENAME,
  PLAYBOOK_TEMPLATE_MARKDOWN,
  formatPlaybookForPrompt,
  parsePlaybookContent
} from '../shared/playbook.js';

test('PLAYBOOK_TEMPLATE_MARKDOWN includes AI-readable structured sections', () => {
  assert.equal(PLAYBOOK_TEMPLATE_FILENAME, 'gemini-nano-playbook-template.md');
  assert.match(PLAYBOOK_TEMPLATE_MARKDOWN, /# 手順書タイトル:/);
  assert.match(PLAYBOOK_TEMPLATE_MARKDOWN, /## 目的/);
  assert.match(PLAYBOOK_TEMPLATE_MARKDOWN, /## 開始URL/);
  assert.match(PLAYBOOK_TEMPLATE_MARKDOWN, /## 実行ステップ/);
  assert.match(PLAYBOOK_TEMPLATE_MARKDOWN, /## 確認ポイント（完了条件）/);
});

test('parsePlaybookContent extracts metadata and steps from Markdown', () => {
  const pb = parsePlaybookContent(PLAYBOOK_TEMPLATE_MARKDOWN, 'my-sop.md');
  assert.equal(pb.filename, 'my-sop.md');
  assert.match(pb.title, /対象サイトの情報確認/);
  assert.equal(pb.startUrl, 'https://example.com');
  assert.ok(pb.steps.length >= 5);
  assert.match(pb.goal, /最終ゴール/);
});

test('parsePlaybookContent normalizes JSON playbook into Markdown', () => {
  const jsonText = JSON.stringify({
    title: '週次レポート取得',
    goal: '管理画面から週次レポートを確認する',
    startUrl: 'https://portal.example.com/reports',
    rules: ['勝手に送信しない'],
    steps: [
      { action: 'navigate', description: 'レポートページへ移動する' },
      { action: 'download_page_pdf', description: 'PDFとして保存する' }
    ],
    completionCriteria: ['PDF保存が完了していること']
  });

  const pb = parsePlaybookContent(jsonText, 'weekly.json');
  assert.equal(pb.title, '週次レポート取得');
  assert.equal(pb.startUrl, 'https://portal.example.com/reports');
  assert.equal(pb.steps.length, 2);
  assert.match(pb.rawText, /\[navigate\] レポートページへ移動する/);
});

test('parsePlaybookContent rejects empty input and formatPlaybookForPrompt truncates long text', () => {
  assert.throws(() => parsePlaybookContent('   ', 'empty.md'), /空です/);
  const longPb = parsePlaybookContent(`# 大規模手順書\n\n## 実行ステップ\n1. ${'あ'.repeat(3000)}`, 'long.md');
  const formatted = formatPlaybookForPrompt(longPb, 500);
  assert.ok(formatted.length <= 500);
  assert.match(formatted, /以降省略/);
});
