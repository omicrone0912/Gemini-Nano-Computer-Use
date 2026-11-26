import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('manifest.json enforces strict local-only CSP and required PDF permissions', () => {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const csp = manifest?.content_security_policy?.extension_pages;
  assert.equal(typeof csp, 'string');
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /img-src 'self' data: blob:/);
  assert.match(csp, /frame-src 'self' blob:/);
  assert.match(csp, /object-src 'none'/);
  assert.ok(manifest.permissions.includes('debugger'));
  assert.ok(manifest.permissions.includes('downloads'));
  assert.ok(manifest.permissions.includes('tabGroups'));
  assert.ok(manifest.permissions.includes('offscreen'));
});

test('sidepanel.html and offscreen.html contain no inline styles or inline scripts under CSP', () => {
  const sidepanelHtml = readFileSync('sidepanel/sidepanel.html', 'utf8');
  assert.doesNotMatch(sidepanelHtml, /\sstyle\s*=/i);
  assert.doesNotMatch(sidepanelHtml, /<style[\s>]/i);

  const offscreenHtml = readFileSync('offscreen/offscreen.html', 'utf8');
  assert.doesNotMatch(offscreenHtml, /\sstyle\s*=/i);
  assert.doesNotMatch(offscreenHtml, /<style[\s>]/i);
  assert.doesNotMatch(offscreenHtml, /<script(?![^>]*\bsrc=)[^>]*>/i);

  const studioHtml = readFileSync('studio/studio.html', 'utf8');
  assert.doesNotMatch(studioHtml, /\sstyle\s*=/i);
  assert.doesNotMatch(studioHtml, /<style[\s>]/i);
  assert.doesNotMatch(studioHtml, /<script(?![^>]*\bsrc=)[^>]*>/i);
});
