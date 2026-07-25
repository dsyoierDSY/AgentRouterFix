import fs from 'node:fs';
import path from 'node:path';

const UNSAFE_PROFILE_HEADERS = new Set([
  'authorization',
  'content-length',
  'content-type',
  'connection',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const FALLBACK_OPENCODE_HEADERS = {
  accept: 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'opencode/1.3.15',
};

export function isOpenCodeRequest(headers) {
  const userAgent = String(headers['user-agent'] ?? '').toLowerCase();
  return userAgent.includes('opencode');
}

export function loadHeaderProfile(file) {
  try {
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!profile || typeof profile !== 'object' || !profile.headers || typeof profile.headers !== 'object') {
      return null;
    }
    return profile.headers;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not read header profile: ${error.message}`);
  }
}

/**
 * Keeps identification/fingerprint headers but never stores credentials or
 * protocol/body framing headers. Cherry's own Authorization remains intact.
 */
export function extractSafeProfileHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (UNSAFE_PROFILE_HEADERS.has(lowerName) || value === undefined) continue;
    result[lowerName] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

export function saveHeaderProfile(file, requestHeaders) {
  const headers = extractSafeProfileHeaders(requestHeaders);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(
    temporary,
    JSON.stringify({ source: 'OpenCode', capturedAt: new Date().toISOString(), headers }, null, 2),
    'utf8',
  );
  fs.renameSync(temporary, file);
  return headers;
}

export function applyHeaderProfile(upstreamHeaders, profileHeaders) {
  for (const [name, value] of Object.entries(profileHeaders)) {
    if (UNSAFE_PROFILE_HEADERS.has(name.toLowerCase())) continue;
    // The profile intentionally overrides Cherry's client-identifying headers
    // while the incoming Authorization header continues untouched.
    upstreamHeaders.set(name, value);
  }
}
