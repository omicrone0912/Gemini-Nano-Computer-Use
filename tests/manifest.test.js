import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('manifest.json enforces strict local-only CSP with connect-src none', () => {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const csp = manifest?.content_security_policy?.extension_pages;
  assert.equal(typeof csp, 'string');
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /img-src 'self' data: blob:/);
  assert.match(csp, /object-src 'none'/);
});
