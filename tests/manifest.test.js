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
});
