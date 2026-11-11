import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credentialsFromEnv } from '../src/profile.js';

function withProfiles(profiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiva-profile-'));
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify(profiles));
  return dir;
}

test('profile supplies key, account and host', () => {
  const dir = withProfiles({ acme: { env: 'production', account: '42', api_key: 'k1' } });
  const c = credentialsFromEnv({ QUIVA_PROFILE: 'acme', QUIVA_CONFIG_DIR: dir });
  assert.equal(c.apiKey, 'k1');
  assert.equal(c.account, '42');
  assert.equal(c.apiUrl, 'https://api.quiva.ai');
});

test('QUIVA_API_KEY_<PROFILE> overrides the profile key', () => {
  const dir = withProfiles({ 'my-co': { env: 'production', account: '1', api_key: 'k1' } });
  const c = credentialsFromEnv({ QUIVA_PROFILE: 'my-co', QUIVA_CONFIG_DIR: dir, QUIVA_API_KEY_MY_CO: 'k2' });
  assert.equal(c.apiKey, 'k2');
});

test('profile without api_key is rejected; no profile falls back to plain env', () => {
  const dir = withProfiles({ internal: { env: 'production', account: '1', login: {} } });
  assert.throws(() => credentialsFromEnv({ QUIVA_PROFILE: 'internal', QUIVA_CONFIG_DIR: dir }), /no api_key/);
  assert.equal(credentialsFromEnv({ QUIVA_API_KEY: 'plain' }).apiKey, 'plain');
});
