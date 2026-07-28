import fs from 'node:fs';
import path from 'node:path';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function parseTimeout(value) {
  const timeout = Number(value ?? 10_000);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000) {
    throw new Error('UPSTREAM_CONNECT_TIMEOUT_MS must be an integer from 100 to 120000.');
  }
  return timeout;
}

function parseBaseUrl(rawValue, label) {
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error(`${label} must be a complete HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} must use http or https.`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.search = '';
  url.hash = '';
  return url;
}

function parseFallbackBaseUrls(env, upstreamBaseUrl) {
  const configured = env.UPSTREAM_FALLBACK_BASE_URLS;
  const rawUrls =
    configured === undefined
      ? ['https://ps.air-outer.com']
      : configured
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);

  const urls = [];
  for (const rawUrl of rawUrls) {
    const url = parseBaseUrl(rawUrl, 'Each UPSTREAM_FALLBACK_BASE_URLS entry');
    // A host-only fallback inherits the API prefix from the primary endpoint.
    if (url.pathname === '/') url.pathname = upstreamBaseUrl.pathname;
    if (url.toString() !== upstreamBaseUrl.toString()) urls.push(url);
  }
  return urls;
}

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

  const upstreamBaseUrl = parseBaseUrl(rawBaseUrl, 'UPSTREAM_BASE_URL');

  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    upstreamBaseUrl,
    upstreamFallbackBaseUrls: parseFallbackBaseUrls(env, upstreamBaseUrl),
    upstreamConnectTimeoutMs: parseTimeout(env.UPSTREAM_CONNECT_TIMEOUT_MS),
    systemProxyFallback: TRUE_VALUES.has(
      (env.SYSTEM_PROXY_FALLBACK ?? 'true').toLowerCase(),
    ),
    systemProxyUrl: env.SYSTEM_PROXY_URL?.trim() || '',
    noProxy: env.NO_PROXY ?? env.no_proxy ?? '',
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
