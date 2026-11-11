// Credential resolution shared by every stdio server (identical copy in each
// package; keep them in sync). Mirrors the quiva-config skill's quiva.mjs:
//   QUIVA_PROFILE=<name> -> ~/.config/quiva/profiles.json (or $QUIVA_CONFIG_DIR/profiles.json)
//   profile shape: { "<name>": { "env": "staging"|"production", "account": "<id>", "api_key": "..." } }
//   QUIVA_API_KEY_<NAME> overrides the profile's key; then QUIVA_API_KEY.
// Profiles without an api_key (e.g. a `login` block) are ignored.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOSTS = { production: 'https://api.quiva.ai', staging: 'https://api.quiva.ai' };

export function profilesPath(env = process.env) {
  const dir = env.QUIVA_CONFIG_DIR || path.join(os.homedir(), '.config', 'quiva');
  return path.join(dir, 'profiles.json');
}

function loadProfile(name, env) {
  const file = profilesPath(env);
  let all;
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`QUIVA_PROFILE=${name} but ${file} could not be read: ${err.code || err.message}`);
  }
  const p = all?.[name];
  if (!p || typeof p !== 'object') throw new Error(`QUIVA_PROFILE=${name}: no such profile in ${file}`);
  const keyVar = `QUIVA_API_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const apiKey = env[keyVar] || p.api_key;
  if (!apiKey) throw new Error(`QUIVA_PROFILE=${name}: profile has no api_key (set ${keyVar} or add one)`);
  const profileEnv = p.env || 'production';
  if (!HOSTS[profileEnv]) throw new Error(`QUIVA_PROFILE=${name}: unknown env "${profileEnv}"`);
  return { apiKey, account: p.account ? String(p.account) : '', apiUrl: HOSTS[profileEnv] };
}

// Returns QuivaClient constructor options. An explicit QUIVA_API_URL always wins
// over the profile's environment.
export function credentialsFromEnv(env = process.env) {
  const base = {
    apiUrl: env.QUIVA_API_URL,
    apiKey: env.QUIVA_API_KEY,
    bearerToken: env.QUIVA_BEARER_TOKEN,
    email: env.QUIVA_EMAIL,
    password: env.QUIVA_PASSWORD,
    account: env.QUIVA_ACCOUNT,
  };
  if (!env.QUIVA_PROFILE) return base;
  const p = loadProfile(env.QUIVA_PROFILE, env);
  return { ...base, apiKey: p.apiKey, account: base.account || p.account, apiUrl: base.apiUrl || p.apiUrl };
}
