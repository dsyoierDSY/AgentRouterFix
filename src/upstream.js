import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';

const NO_BODY_STATUS = new Set([101, 204, 205, 304]);
const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:']);
const WINDOWS_INTERNET_SETTINGS =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function envValue(env, ...names) {
  for (const name of names) {
    if (env[name] !== undefined) return env[name];
    const found = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
    if (found) return env[found];
  }
  return undefined;
}

function normalizeHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function defaultPort(url) {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function authority(url) {
  const host = net.isIP(normalizeHost(url.hostname)) === 6 ? `[${normalizeHost(url.hostname)}]` : url.hostname;
  return `${host}:${defaultPort(url)}`;
}

function endpointLabel(url) {
  return `${url.protocol}//${url.host}`;
}

function proxyLabel(url) {
  return `${url.protocol}//${url.host}`;
}

function errorMessage(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return 'connection timed out';
  }
  return error?.cause?.message || error?.message || String(error);
}

function parseProxyUrl(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) return null;
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    return null;
  }
}

function proxyAuthorization(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return null;
  const username = decodeURIComponent(proxyUrl.username);
  const password = decodeURIComponent(proxyUrl.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function toNodeHeaders(headers, targetUrl, proxyUrl, body) {
  const result = {};
  for (const [name, value] of new Headers(headers).entries()) result[name] = value;
  result.host = targetUrl.host;

  const authorization = proxyAuthorization(proxyUrl);
  if (authorization) result['proxy-authorization'] = authorization;
  if (body && result['content-length'] === undefined) {
    result['content-length'] = String(body.length);
  }
  return result;
}

function responseHeaders(message) {
  const headers = new Headers();
  if (message.rawHeaders?.length) {
    for (let index = 0; index < message.rawHeaders.length; index += 2) {
      headers.append(message.rawHeaders[index], message.rawHeaders[index + 1]);
    }
  } else {
    for (const [name, value] of Object.entries(message.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else {
        headers.append(name, value);
      }
    }
  }
  return headers;
}

function incomingResponse(message, method, url) {
  const status = message.statusCode ?? 502;
  const hasBody = method !== 'HEAD' && !NO_BODY_STATUS.has(status);
  if (!hasBody) message.resume();
  return {
    status,
    statusText: message.statusMessage ?? '',
    headers: responseHeaders(message),
    body: hasBody ? Readable.toWeb(message) : null,
    url: url.toString(),
  };
}

function timeoutError(timeoutMs) {
  const error = new Error(`Upstream did not return response headers within ${timeoutMs} ms.`);
  error.code = 'ETIMEDOUT';
  return error;
}

function requestHttpTargetViaProxy(targetUrl, init, proxyUrl, timeoutMs) {
  const transport = proxyUrl.protocol === 'https:' ? https : http;
  const body = init.body;

  return new Promise((resolve, reject) => {
    let settled = false;
    const request = transport.request(
      {
        protocol: proxyUrl.protocol,
        hostname: normalizeHost(proxyUrl.hostname),
        port: defaultPort(proxyUrl),
        method: init.method,
        path: targetUrl.toString(),
        headers: toNodeHeaders(init.headers, targetUrl, proxyUrl, body),
        servername: net.isIP(normalizeHost(proxyUrl.hostname)) ? undefined : normalizeHost(proxyUrl.hostname),
      },
      (response) => {
        if (settled) return response.destroy();
        settled = true;
        clearTimeout(timer);
        resolve(incomingResponse(response, init.method, targetUrl));
      },
    );

    const timer = setTimeout(() => request.destroy(timeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
    request.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    request.end(body);
  });
}

function requestHttpsTargetViaProxy(targetUrl, init, proxyUrl, timeoutMs) {
  const proxyTransport = proxyUrl.protocol === 'https:' ? https : http;
  const body = init.body;

  return new Promise((resolve, reject) => {
    let settled = false;
    let tunnelSocket;
    let secureSocket;
    let upstreamRequest;

    const finishWithError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      upstreamRequest?.destroy();
      secureSocket?.destroy();
      tunnelSocket?.destroy();
      reject(error);
    };

    const connectHeaders = { host: authority(targetUrl) };
    const authorization = proxyAuthorization(proxyUrl);
    if (authorization) connectHeaders['proxy-authorization'] = authorization;

    const connectRequest = proxyTransport.request({
      protocol: proxyUrl.protocol,
      hostname: normalizeHost(proxyUrl.hostname),
      port: defaultPort(proxyUrl),
      method: 'CONNECT',
      path: authority(targetUrl),
      headers: connectHeaders,
      servername: net.isIP(normalizeHost(proxyUrl.hostname)) ? undefined : normalizeHost(proxyUrl.hostname),
    });

    const timer = setTimeout(() => {
      connectRequest.destroy(timeoutError(timeoutMs));
      finishWithError(timeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();

    connectRequest.once('error', finishWithError);
    connectRequest.once('connect', (connectResponse, socket, head) => {
      tunnelSocket = socket;
      if (connectResponse.statusCode !== 200) {
        const error = new Error(
          `System proxy refused the CONNECT tunnel with HTTP ${connectResponse.statusCode}.`,
        );
        error.code = 'ERR_PROXY_CONNECT';
        error.retryable = false;
        socket.destroy();
        return finishWithError(error);
      }

      if (head?.length) socket.unshift(head);
      const targetHostname = normalizeHost(targetUrl.hostname);
      secureSocket = tls.connect({
        socket,
        servername: net.isIP(targetHostname) ? undefined : targetHostname,
        ALPNProtocols: ['http/1.1'],
      });
      secureSocket.once('error', finishWithError);
      secureSocket.once('secureConnect', () => {
        const agent = new https.Agent({ keepAlive: false });
        agent.createConnection = () => secureSocket;

        upstreamRequest = https.request(
          {
            protocol: 'https:',
            hostname: targetHostname,
            port: defaultPort(targetUrl),
            method: init.method,
            path: `${targetUrl.pathname}${targetUrl.search}`,
            headers: toNodeHeaders(init.headers, targetUrl, new URL('http://proxy.invalid'), body),
            agent,
          },
          (response) => {
            if (settled) return response.destroy();
            settled = true;
            clearTimeout(timer);
            response.once('close', () => agent.destroy());
            resolve(incomingResponse(response, init.method, targetUrl));
          },
        );
        // Proxy credentials belong only on CONNECT, never on the tunneled
        // request sent to the upstream.
        upstreamRequest.removeHeader('proxy-authorization');
        upstreamRequest.once('error', finishWithError);
        upstreamRequest.end(body);
      });
    });
    connectRequest.end();
  });
}

/**
 * Sends one request through an HTTP(S) forward proxy. HTTPS upstreams use
 * CONNECT and preserve streaming response bodies.
 */
export function requestViaProxy(target, init, proxy, timeoutMs = 10_000) {
  const targetUrl = target instanceof URL ? target : new URL(target);
  const proxyUrl = proxy instanceof URL ? proxy : parseProxyUrl(proxy);
  if (!proxyUrl || !SUPPORTED_PROXY_PROTOCOLS.has(proxyUrl.protocol)) {
    throw new Error('Only HTTP and HTTPS system proxies are supported.');
  }
  return targetUrl.protocol === 'https:'
    ? requestHttpsTargetViaProxy(targetUrl, init, proxyUrl, timeoutMs)
    : requestHttpTargetViaProxy(targetUrl, init, proxyUrl, timeoutMs);
}

/**
 * Parses the formats used by the Windows Internet Settings ProxyServer value:
 *   127.0.0.1:7890
 *   http=127.0.0.1:7890;https=127.0.0.1:7890
 */
export function parseWindowsProxyServer(value) {
  const text = String(value ?? '').trim();
  if (!text) return {};
  if (!text.includes('=')) return { all: text };

  const parsed = {};
  for (const entry of text.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const type = entry.slice(0, separator).trim().toLowerCase();
    const address = entry.slice(separator + 1).trim();
    if (address && ['http', 'https', 'socks'].includes(type)) parsed[type] = address;
  }
  return parsed;
}

export function parseWindowsInternetSettings(output) {
  const settings = {};
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(ProxyEnable|ProxyServer|AutoConfigURL)\s+REG_\w+\s+(.*?)\s*$/i);
    if (!match) continue;
    settings[match[1].toLowerCase()] = match[2];
  }
  return {
    proxyEnabled: /^(?:0x)?1$/i.test(settings.proxyenable ?? ''),
    proxyServer: settings.proxyserver ?? '',
    autoConfigUrl: settings.autoconfigurl ?? '',
  };
}

function readWindowsInternetSettings() {
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync(
      'reg.exe',
      ['query', WINDOWS_INTERNET_SETTINGS],
      { encoding: 'utf8', timeout: 2_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return parseWindowsInternetSettings(output);
  } catch {
    return null;
  }
}

export function shouldBypassProxy(target, noProxyValue) {
  const targetUrl = target instanceof URL ? target : new URL(target);
  const hostname = normalizeHost(targetUrl.hostname);
  const port = String(defaultPort(targetUrl));

  for (const rawEntry of String(noProxyValue ?? '').split(',')) {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;

    let entryPort = '';
    if (entry.startsWith('[')) {
      const closingBracket = entry.indexOf(']');
      if (closingBracket >= 0) {
        const suffix = entry.slice(closingBracket + 1);
        entryPort = suffix.startsWith(':') ? suffix.slice(1) : '';
        entry = entry.slice(1, closingBracket);
      }
    } else {
      const colon = entry.lastIndexOf(':');
      if (colon > 0 && entry.indexOf(':') === colon) {
        entryPort = entry.slice(colon + 1);
        entry = entry.slice(0, colon);
      }
    }
    if (entryPort && entryPort !== port) continue;

    entry = entry.replace(/^\*\./, '.');
    if (entry.startsWith('.')) {
      const domain = entry.slice(1);
      if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
    } else if (hostname === entry || hostname.endsWith(`.${entry}`)) {
      return true;
    }
  }
  return false;
}

function proxyCandidatesForTarget(targetUrl, env, configuredProxyUrl, windowsSettings) {
  const candidates = [];
  if (configuredProxyUrl) candidates.push({ value: configuredProxyUrl, source: 'configuration' });

  const variableNames =
    targetUrl.protocol === 'https:'
      ? ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']
      : ['HTTP_PROXY', 'ALL_PROXY'];
  for (const name of variableNames) {
    const value = envValue(env, name);
    if (value) candidates.push({ value, source: name });
  }

  const settings = windowsSettings ?? readWindowsInternetSettings();
  if (settings?.proxyEnabled && settings.proxyServer) {
    const parsed = parseWindowsProxyServer(settings.proxyServer);
    const value = parsed[targetUrl.protocol.slice(0, -1)] ?? parsed.all;
    if (value) candidates.push({ value, source: 'Windows Internet Settings' });
  }
  return candidates;
}

/**
 * Resolves a usable system HTTP(S) proxy without evaluating PAC JavaScript.
 * Environment variables take precedence over Windows static proxy settings.
 */
export function resolveSystemProxy(
  target,
  {
    env = process.env,
    configuredProxyUrl = '',
    noProxy = envValue(env, 'NO_PROXY') ?? '',
    windowsSettings,
  } = {},
) {
  const targetUrl = target instanceof URL ? target : new URL(target);
  if (shouldBypassProxy(targetUrl, noProxy)) return null;

  for (const candidate of proxyCandidatesForTarget(
    targetUrl,
    env,
    configuredProxyUrl,
    windowsSettings,
  )) {
    const proxyUrl = parseProxyUrl(candidate.value);
    if (proxyUrl && SUPPORTED_PROXY_PROTOCOLS.has(proxyUrl.protocol)) {
      return { proxyUrl, source: candidate.source };
    }
  }
  return null;
}

async function directFetch(fetchImpl, targetUrl, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(targetUrl, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attempt order:
 *   1. primary and alternate upstreams directly;
 *   2. primary and alternate upstreams through the discovered system proxy.
 *
 * A received HTTP response, including 4xx/5xx, is final and is never retried.
 */
export async function requestUpstream(
  targets,
  init,
  {
    fetchImpl = fetch,
    proxyRequestImpl = requestViaProxy,
    proxyResolver = resolveSystemProxy,
    systemProxyFallback = true,
    systemProxyUrl = '',
    noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '',
    timeoutMs = 10_000,
    logger = console,
  } = {},
) {
  let lastError;

  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    try {
      return await directFetch(fetchImpl, target, init, timeoutMs);
    } catch (error) {
      lastError = error;
      logger.info(
        `Direct connection to ${endpointLabel(target)} failed: ${errorMessage(error)}${
          index + 1 < targets.length ? '; trying alternate upstream.' : ''
        }`,
      );
    }
  }

  if (!systemProxyFallback) throw lastError;

  let foundProxy = false;
  for (const target of targets) {
    const resolved = proxyResolver(target, {
      configuredProxyUrl: systemProxyUrl,
      noProxy,
    });
    if (!resolved) continue;
    foundProxy = true;
    logger.info(
      `Retrying ${endpointLabel(target)} through system proxy ${proxyLabel(resolved.proxyUrl)} (${resolved.source}).`,
    );
    try {
      return await proxyRequestImpl(target, init, resolved.proxyUrl, timeoutMs);
    } catch (error) {
      lastError = error;
      logger.info(
        `System proxy request to ${endpointLabel(target)} failed: ${errorMessage(error)}.`,
      );
      if (error?.retryable === false) throw error;
    }
  }

  if (!foundProxy) {
    logger.info('No supported system HTTP(S) proxy was found for the upstream URL.');
  }
  throw lastError ?? new Error('No upstream endpoint could be reached.');
}
