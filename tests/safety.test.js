import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessActionRisk,
  detectActionLoop,
  validateNavigationUrl
} from '../shared/safety.js';

test('validateNavigationUrl permits http/https and normalizes bare domains', () => {
  const httpsRes = validateNavigationUrl('https://example.com/path');
  assert.equal(httpsRes.valid, true);
  assert.equal(httpsRes.url, 'https://example.com/path');

  const bareRes = validateNavigationUrl('ja.wikipedia.org');
  assert.equal(bareRes.valid, true);
  assert.equal(bareRes.url, 'https://ja.wikipedia.org/');
});

test('validateNavigationUrl blocks dangerous schemes', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,hi']) {
    const res = validateNavigationUrl(bad);
    assert.equal(res.valid, false);
  }
});

test('assessActionRisk flags password inputs and purchase/delete buttons for confirmation', () => {
  const snapshot = {
    elements: [
      { id: 1, tag: 'input', inputType: 'password', label: 'パスワード' },
      { id: 2, tag: 'button', label: '注文を確定して購入する' },
      { id: 3, tag: 'a', label: '次の記事へ' }
    ]
  };

  assert.equal(assessActionRisk({ action: 'type', elementId: 1, text: 'secret' }, snapshot).level, 'confirm');
  assert.equal(assessActionRisk({ action: 'click', elementId: 2 }, snapshot).level, 'confirm');
  assert.equal(assessActionRisk({ action: 'click', elementId: 3 }, snapshot).level, 'safe');
  assert.equal(assessActionRisk({ action: 'navigate', url: 'javascript:void(0)' }, snapshot).level, 'blocked');
});

test('detectActionLoop detects 3 identical consecutive actions', () => {
  const history = [
    { step: 1, action: { action: 'click', elementId: 5 } },
    { step: 2, action: { action: 'click', elementId: 5 } }
  ];
  assert.equal(detectActionLoop(history, { action: 'click', elementId: 5 }, 3), true);
  assert.equal(detectActionLoop(history, { action: 'scroll', direction: 'down' }, 3), false);
});
