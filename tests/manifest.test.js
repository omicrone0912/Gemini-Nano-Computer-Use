import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('manifest.json enforces strict local-only CSP and required PDF permissions', () => {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const csp = manifest?.content_security_policy?.extension_pages;
  assert.equal(typeof csp, 'string');
  assert.match(csp, /connect-src http:\/\/127\.0\.0\.1:11434 http:\/\/localhost:11434/);
  const connectDirective = csp.split(';').find((d) => d.trim().startsWith('connect-src')) || '';
  assert.doesNotMatch(connectDirective, /https:|wss?:|\*/i);
  assert.match(csp, /img-src 'self' data: blob:/);
  assert.match(csp, /media-src 'self' blob: data:/);
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

  const studioJs = readFileSync('studio/studio.js', 'utf8');
  assert.doesNotMatch(studioJs, /\.cssText\b/);
  assert.doesNotMatch(studioJs, /setAttribute\(\s*['"]style['"]/i);

  const viewerHtml = readFileSync('viewer/viewer.html', 'utf8');
  assert.doesNotMatch(viewerHtml, /\sstyle\s*=/i);
  assert.doesNotMatch(viewerHtml, /<style[\s>]/i);
  assert.doesNotMatch(viewerHtml, /<script(?![^>]*\bsrc=)[^>]*>/i);

  const viewerJs = readFileSync('viewer/viewer.js', 'utf8');
  assert.doesNotMatch(viewerJs, /\.cssText\b/);
  assert.doesNotMatch(viewerJs, /setAttribute\(\s*['"]style['"]/i);
});

test('sidepanel.html consolidates settings into #settingsModal triggered by #openSettingsBtn', () => {
  const html = readFileSync('sidepanel/sidepanel.html', 'utf8');
  assert.match(html, /id="openSettingsBtn"/);
  const modalIdx = html.indexOf('id="settingsModal"');
  assert.ok(modalIdx > -1);
  const modalSlice = html.slice(modalIdx);
  for (const id of [
    'executionModeSelect',
    'useVisionCheckbox',
    'allowBackgroundCheckbox',
    'allowMultiTabCheckbox',
    'useBuiltInViewerCheckbox',
    'useQwenFallbackCheckbox',
    'qwenPanel',
    'setupGuide'
  ]) {
    assert.ok(modalSlice.includes(`id="${id}"`), `Expected #${id} inside #settingsModal`);
    assert.equal(html.indexOf(`id="${id}"`), modalSlice.indexOf(`id="${id}"`) + modalIdx, `Expected unique #${id}`);
  }
});
