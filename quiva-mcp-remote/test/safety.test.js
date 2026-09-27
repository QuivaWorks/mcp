// Static checks: remote-safe packages, production-only defaults, a failed import skips.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { credentialFrom, isJwtShaped, redact } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PACKAGES, REPO_ROOT, loadPackages } from '../src/packages.js';

const HERE = join(REPO_ROOT, 'quiva-mcp-remote');

// Anything here means a tool may touch the local disk or spawn: review it and
// add it to DENYLIST. Reads of the package's own examples/ are expected.
const UNSAFE = /child_process|\bspawn\(|\bexec(Sync|File)?\(|writeFile|appendFile|createWriteStream|\bmkdir|\bunlink|\brmSync|\brm\(|process\.chdir/;

test('composed packages neither write files nor spawn processes', () => {
  for (const pkg of PACKAGES) {
    const src = join(REPO_ROOT, pkg.dir, 'src');
    if (!existsSync(src)) continue;
    for (const file of readdirSync(src).filter((f) => f.endsWith('.js'))) {
      const text = readFileSync(join(src, file), 'utf8');
      assert.doesNotMatch(text, UNSAFE, `${pkg.dir}/src/${file}`);
    }
  }
});

test('defaults point at production only', () => {
  assert.equal(loadConfig({}).apiUrl, 'https://api.quiva.ai');
  for (const file of ['src/config.js', 'src/server.js', 'src/packages.js', 'src/compose.js', 'src/auth.js', 'src/limits.js', 'Dockerfile', 'README.md']) {
    const path = join(HERE, file);
    if (existsSync(path)) assert.doesNotMatch(readFileSync(path, 'utf8'), /microstrate\.io/, file);
  }
});

test('config rejects bad numbers', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.equal(loadConfig({}).maxBodyBytes, 1024 * 1024);
  assert.throws(() => loadConfig({ HEADERS_TIMEOUT_MS: '40000' }), /HEADERS_TIMEOUT_MS/);
});

test('credential shapes', () => {
  assert.equal(isJwtShaped('a.b.c'), true);
  assert.equal(isJwtShaped('QK_ABCDEF'), false);
  assert.deepEqual(credentialFrom({ authorization: 'Bearer QK_ABC' }), { apiKey: 'QK_ABC' });
  assert.deepEqual(credentialFrom({ authorization: 'bearer x.y.z' }), { bearerToken: 'x.y.z' });
  assert.deepEqual(credentialFrom({ 'x-api-key': 'QK_ABC' }), { apiKey: 'QK_ABC' });
  assert.equal(credentialFrom({}), null);
  assert.equal(credentialFrom({ authorization: 'Basic abc' }), null);
});

test('redact strips the credential and any bearer value', () => {
  const out = redact('failed QK_SECRET with Authorization: Bearer abc.def.ghi', { apiKey: 'QK_SECRET' });
  assert.doesNotMatch(out, /QK_SECRET|abc\.def\.ghi/);
});

test('a missing package is skipped, not fatal', async () => {
  const lines = [];
  const loaded = await loadPackages({
    packages: [{ dir: 'quiva-does-not-exist-mcp', prefix: 'nope_' }, PACKAGES[0]],
    log: (l) => lines.push(l),
  });
  assert.equal(loaded.length, 1);
  assert.match(lines.join('\n'), /skipping quiva-does-not-exist-mcp/);
});
