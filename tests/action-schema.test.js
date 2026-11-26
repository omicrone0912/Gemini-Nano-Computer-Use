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
