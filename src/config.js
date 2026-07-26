import fs from 'node:fs';
import path from 'node:path';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * Loads a deliberately small subset of .env syntax so this proxy has no
 * runtime dependencies. Existing process environment values always win.
 */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;

  const entries = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const rawLine of entries) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

export function createConfig(env = process.env) {
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  const rawBaseUrl = env.UPSTREAM_BASE_URL?.trim();
  if (!rawBaseUrl) {
    throw new Error('UPSTREAM_BASE_URL is required. Copy it from the AgentRouter dashboard.');
  }

  let upstreamBaseUrl;
  try {
    upstreamBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error('UPSTREAM_BASE_URL must be a complete HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(upstreamBaseUrl.protocol)) {
    throw new Error('UPSTREAM_BASE_URL must use http or https.');
  }

  // Normalization makes path joining predictable, including bases such as /v1.
  upstreamBaseUrl.pathname = upstreamBaseUrl.pathname.replace(/\/+$/, '') || '/';
  upstreamBaseUrl.search = '';
  upstreamBaseUrl.hash = '';

  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    upstreamBaseUrl,
    localProxyApiKey: env.LOCAL_PROXY_API_KEY?.trim() || '',
    cherryUseOpenCodeProfile: TRUE_VALUES.has(
      (env.CHERRY_USE_OPENCODE_PROFILE ?? 'true').toLowerCase(),
    ),
    openCodeHeaderProfileFile: path.resolve(
      process.cwd(),
      env.CLIENT_HEADER_PROFILE_FILE?.trim() ||
        env.OPENCODE_HEADER_PROFILE_FILE?.trim() ||
        '.client-header-profile.json',
    ),
    dropBillingSse: TRUE_VALUES.has((env.DROP_BILLING_SSE ?? 'true').toLowerCase()),
    logLevel: (env.LOG_LEVEL ?? 'info').toLowerCase(),
  };
}
