import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObjectString, parseActionResponse } from '../shared/action-schema.js';

test('parseActionResponse parses valid click action JSON', () => {
  const raw = JSON.stringify({
    thought: '検索ボタンをクリックします',
    action: 'click',
    elementId: 4
  });

  const parsed = parseActionResponse(raw);
  assert.equal(parsed.action, 'click');
  assert.equal(parsed.elementId, 4);
  assert.equal(parsed.thought, '検索ボタンをクリックします');
});

test('parseActionResponse extracts JSON wrapped in markdown fences and extra text', () => {
  const raw = `以下が次の操作です。
\`\`\`json
{
  "thought": "検索語を入力します",
  "action": "input",
  "element_id": "#12",
  "text": "Gemini Nano",
  "submit": true
}
\`\`\`
よろしくお願いします。`;

  const parsed = parseActionResponse(raw);
  assert.equal(parsed.action, 'type');
  assert.equal(parsed.elementId, 12);
  assert.equal(parsed.text, 'Gemini Nano');
  assert.equal(parsed.submit, true);
  assert.equal(parsed.clear, true);
});

test('parseActionResponse clamps wait duration and defaults scroll direction', () => {
  const waitAction = parseActionResponse('{"thought":"待機","action":"wait","ms":99999}');
  assert.equal(waitAction.ms, 5000);

  const scrollAction = parseActionResponse('{"thought":"下へ","action":"scroll"}');
  assert.equal(scrollAction.direction, 'down');
});

test('parseActionResponse rejects unsupported actions or missing elementId', () => {
  assert.throws(() => parseActionResponse('{"thought":"x","action":"hack"}'), /未対応のアクション/);
  assert.throws(() => parseActionResponse('{"thought":"x","action":"click"}'), /elementId/);
  assert.throws(() => extractJsonObjectString('no json here'), /JSON オブジェクトが見つかりません/);
});

test('parseActionResponse normalizes download_page_pdf and read_pdf actions', () => {
  const dl = parseActionResponse('{"thought":"PDF保存","action":"save_pdf","filename":"summary.pdf"}');
  assert.equal(dl.action, 'download_page_pdf');
  assert.equal(dl.filename, 'summary.pdf');

  const rdDefault = parseActionResponse('{"thought":"PDF読込","action":"read_pdf"}');
  assert.equal(rdDefault.action, 'read_pdf');
  assert.equal(rdDefault.page, 1);

  const rdPage = parseActionResponse('{"thought":"3ページ目","action":"inspect_pdf","page":"3"}');
  assert.equal(rdPage.action, 'read_pdf');
  assert.equal(rdPage.page, 3);
});
