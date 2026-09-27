// Per-request credential extraction. Email/password is never accepted over HTTP.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const API_KEY_HINT = 'Create an API key in Quiva: Settings → API keys';

export function isJwtShaped(token) {
  return JWT_SHAPE.test(token);
}

function header(headers, name) {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v ?? '').trim();
}

// Returns QuivaClient credential options, or null when none was sent.
export function credentialFrom(headers) {
  const auth = header(headers, 'authorization');
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  if (match) {
    const token = match[1];
    return isJwtShaped(token) ? { bearerToken: token } : { apiKey: token };
  }
  const key = header(headers, 'x-api-key');
  return key ? { apiKey: key } : null;
}

// Strips any credential value from text before it is logged.
export function redact(text, cred) {
  let out = String(text ?? '');
  for (const secret of [cred?.apiKey, cred?.bearerToken]) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out.replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
}
