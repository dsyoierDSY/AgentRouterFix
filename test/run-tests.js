import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createConfig } from '../src/config.js';
import { applyHeaderProfile, extractSafeProfileHeaders } from '../src/header-profile.js';
import { createProxyServer } from '../src/server.js';
import {
  isNullCompatibilityEvent,
  isOutOfBandBillingEvent,
  SseEventFilter,
} from '../src/sse.js';
import {
  parseWindowsInternetSettings,
  parseWindowsProxyServer,
  resolveSystemProxy,
} from '../src/upstream.js';

let passed = 0;

async function run(name, action) {
  try {
    await action();
    passed++;
    console.info(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const quietLogger = { info() {}, debug() {}, error() {} };

await run('recognizes unsupported billing SSE event only', () => {
  assert.equal(
    isOutOfBandBillingEvent(
      'data: {"object":"billing.summary","billing":{"source":"request"}}\n\n',
    ),
    true,
  );
  assert.equal(
    isOutOfBandBillingEvent(
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n',
    ),
    false,
  );
  assert.equal(isOutOfBandBillingEvent('data: [DONE]\n\n'), false);
  assert.equal(isNullCompatibilityEvent('data: null\n\n'), true);
  assert.equal(isNullCompatibilityEvent('data: {"choices":[]}\n\n'), false);
});

await run('filters a billing event split across byte chunks', () => {
  let drops = 0;
  const filter = new SseEventFilter({ onDrop: () => drops++ });
  const bytes = new TextEncoder().encode(
    [
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"object":"billing.summary","billing":{"source":"request"}}\n\n',
      'data: [DONE]\n\n',
    ].join(''),
  );
  const outputs = [];
  for (const chunk of [bytes.subarray(0, 33), bytes.subarray(33, 111), bytes.subarray(111)]) {
    const result = filter.push(chunk);
    if (result) outputs.push(result);
  }
  const tail = filter.flush();
  if (tail) outputs.push(tail);

  const text = new TextDecoder().decode(Buffer.concat(outputs));
  assert.match(text, /chat\.completion\.chunk/);
  assert.match(text, /\[DONE\]/);
  assert.doesNotMatch(text, /billing\.summary/);
  assert.equal(drops, 1);
});

await run('filters the literal null SSE frame emitted by Opus routes', () => {
  const filter = new SseEventFilter();
  const input = [
    'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"checking"}}]}\n\n',
    'data: null\n\n',
    'data: {"object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');

  const output = filter.push(new TextEncoder().encode(input));
  const tail = filter.flush();
  const text = new TextDecoder().decode(
    Buffer.concat([output ?? new Uint8Array(), tail ?? new Uint8Array()]),
  );

  assert.doesNotMatch(text, /data: null/);
  assert.match(text, /"name":"read"/);
  assert.match(text, /\[DONE\]/);
});

await run('moves OpenCode identification headers without replacing Authorization', () => {
  const safeHeaders = extractSafeProfileHeaders({
    authorization: 'Bearer original-opencode-value',
    'user-agent': 'opencode/1.3.15',
    'x-opencode-client': 'desktop',
    'content-type': 'application/json',
  });
  assert.deepEqual(safeHeaders, {
    'user-agent': 'opencode/1.3.15',
    'x-opencode-client': 'desktop',
  });

  const headers = new Headers({
    authorization: 'Bearer value-sent-by-cherry',
    'user-agent': 'CherryStudio/1.0',
  });
  applyHeaderProfile(headers, safeHeaders);
  assert.equal(headers.get('authorization'), 'Bearer value-sent-by-cherry');
  assert.equal(headers.get('user-agent'), 'opencode/1.3.15');
  assert.equal(headers.get('x-opencode-client'), 'desktop');
});

await run('proxies valid chunks, filters billing, and preserves OpenCode headers', async () => {
  let receivedHeaders;
  const upstream = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.write('data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"ok"}}]}\n\n');
    res.write('data: {"object":"billing.summary","billing":{"source":"request"}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const upstreamPort = await listen(upstream);
  const config = createConfig({
    UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
  });
  const proxy = createProxyServer(config, { logger: quietLogger });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer agentrouter-key-from-opencode',
        'content-type': 'application/json',
        'user-agent': 'opencode/1.2.3',
        'x-opencode-client': 'desktop',
      },
      body: '{"model":"kimi-k3","stream":true,"messages":[]}',
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /\[DONE\]/);
    assert.doesNotMatch(text, /billing\.summary/);
    assert.equal(receivedHeaders.authorization, 'Bearer agentrouter-key-from-opencode');
    assert.equal(receivedHeaders['user-agent'], 'opencode/1.2.3');
    assert.equal(receivedHeaders['x-opencode-client'], 'desktop');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

await run('does not require an extra local key by default', async () => {
  let receivedAuthorization;
  const upstream = http.createServer((req, res) => {
    receivedAuthorization = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"object":"list","data":[]}');
  });
  const upstreamPort = await listen(upstream);
  const config = createConfig({
    UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
  });
  const proxy = createProxyServer(config, { logger: quietLogger });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
      headers: { authorization: 'Bearer agentrouter-key-from-opencode' },
    });
    assert.equal(response.status, 200);
    assert.equal(receivedAuthorization, 'Bearer agentrouter-key-from-opencode');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

await run('accepts Cherry Studio style paths that omit /v1 from its configured base URL', async () => {
  let receivedPath;
  const upstream = http.createServer((req, res) => {
    receivedPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"object":"list","data":[]}');
  });
  const upstreamPort = await listen(upstream);
  const config = createConfig({
    UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
  });
  const proxy = createProxyServer(config, { logger: quietLogger });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/models`, {
      headers: { authorization: 'Bearer agentrouter-key-from-cherry' },
    });
    assert.equal(response.status, 200);
    assert.equal(receivedPath, '/v1/models');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

await run('health check is available without a key', async () => {
  const config = createConfig({ UPSTREAM_BASE_URL: 'https://example.test/v1' });
  const proxy = createProxyServer(config, { logger: quietLogger });
  const proxyPort = await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: 'agentrouter-openai-compat',
    });
  } finally {
    await close(proxy);
  }
});

await run('uses the primary direct connection without consulting a system proxy', async () => {
  let proxyResolverCalls = 0;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"object":"list","data":[]}');
  });
  const upstreamPort = await listen(upstream);
  const config = createConfig({
    UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    UPSTREAM_FALLBACK_BASE_URLS: '',
  });
  const proxy = createProxyServer(config, {
    logger: quietLogger,
    proxyResolver() {
      proxyResolverCalls++;
      return null;
    },
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
    assert.equal(response.status, 200);
    assert.equal(proxyResolverCalls, 0);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

await run('tries the official alternate upstream after a direct network failure', async () => {
  const unreachablePort = await unusedPort();
  let alternateRequests = 0;
  const alternate = http.createServer((req, res) => {
    alternateRequests++;
    assert.equal(req.url, '/v1/models');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"object":"list","data":[{"id":"alternate-ok"}]}');
  });
  const alternatePort = await listen(alternate);
  const config = createConfig({
    UPSTREAM_BASE_URL: `http://127.0.0.1:${unreachablePort}/v1`,
    UPSTREAM_FALLBACK_BASE_URLS: `http://127.0.0.1:${alternatePort}/v1`,
    SYSTEM_PROXY_FALLBACK: 'false',
    UPSTREAM_CONNECT_TIMEOUT_MS: '500',
  });
  const proxy = createProxyServer(config, { logger: quietLogger });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /alternate-ok/);
    assert.equal(alternateRequests, 1);
  } finally {
    await close(proxy);
    await close(alternate);
  }
});

await run('falls back through the system proxy and preserves POST SSE data', async () => {
  const unreachablePort = await unusedPort();
  const requestBody = '{"model":"claude-opus-4.8","stream":true,"messages":[]}';
  let proxyRequests = 0;
  let bodySeenByProxy;

  const systemProxy = http.createServer(async (req, res) => {
    proxyRequests++;
    assert.equal(
      req.url,
      `http://127.0.0.1:${unreachablePort}/v1/chat/completions`,
    );
    assert.equal(req.headers.authorization, 'Bearer forwarded-value');
    bodySeenByProxy = await readRequestBody(req);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.write('data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"ok"}}]}\n\n');
    res.write('data: null\n\n');
    res.write('data: {"object":"billing.summary","billing":{"source":"request"}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const systemProxyPort = await listen(systemProxy);
  const config = createConfig({
    UPSTREAM_BASE_URL: `http://127.0.0.1:${unreachablePort}/v1`,
    UPSTREAM_FALLBACK_BASE_URLS: '',
    SYSTEM_PROXY_FALLBACK: 'true',
    SYSTEM_PROXY_URL: `http://127.0.0.1:${systemProxyPort}`,
    NO_PROXY: '',
    UPSTREAM_CONNECT_TIMEOUT_MS: '500',
  });
  const proxy = createProxyServer(config, { logger: quietLogger });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer forwarded-value',
        'content-type': 'application/json',
      },
      body: requestBody,
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(proxyRequests, 1);
    assert.equal(bodySeenByProxy, requestBody);
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /\[DONE\]/);
    assert.doesNotMatch(text, /billing\.summary/);
    assert.doesNotMatch(text, /data: null/);
  } finally {
    await close(proxy);
    await close(systemProxy);
  }
});

await run('does not retry HTTP 401 or 500 responses through a proxy', async () => {
  let proxyRequests = 0;
  const upstream = http.createServer((req, res) => {
    const status = req.url.includes('/models') ? 401 : 500;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(`{"status":${status}}`);
  });
  const upstreamPort = await listen(upstream);
  const systemProxy = http.createServer((_req, res) => {
    proxyRequests++;
    res.writeHead(200);
    res.end();
  });
  const systemProxyPort = await listen(systemProxy);
  const config = createConfig({
    UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    UPSTREAM_FALLBACK_BASE_URLS: '',
    SYSTEM_PROXY_URL: `http://127.0.0.1:${systemProxyPort}`,
    NO_PROXY: '',
  });
  const proxy = createProxyServer(config, { logger: quietLogger });
  const proxyPort = await listen(proxy);

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
    const serverError = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(serverError.status, 500);
    assert.equal(proxyRequests, 0);
  } finally {
    await close(proxy);
    await close(systemProxy);
    await close(upstream);
  }
});

await run('parses environment and Windows system proxy formats', () => {
  assert.deepEqual(parseWindowsProxyServer('127.0.0.1:7890'), {
    all: '127.0.0.1:7890',
  });
  assert.deepEqual(
    parseWindowsProxyServer(
      'http=127.0.0.1:7890;https=http://127.0.0.1:7891;socks=127.0.0.1:7892',
    ),
    {
      http: '127.0.0.1:7890',
      https: 'http://127.0.0.1:7891',
      socks: '127.0.0.1:7892',
    },
  );
  assert.deepEqual(
    parseWindowsInternetSettings(`
      ProxyEnable    REG_DWORD    0x1
      ProxyServer    REG_SZ       http=127.0.0.1:7890;https=127.0.0.1:7891
      AutoConfigURL  REG_SZ       http://127.0.0.1/proxy.pac
    `),
    {
      proxyEnabled: true,
      proxyServer: 'http=127.0.0.1:7890;https=127.0.0.1:7891',
      autoConfigUrl: 'http://127.0.0.1/proxy.pac',
    },
  );

  const fromEnvironment = resolveSystemProxy('https://agentrouter.org/v1', {
    env: {
      HTTPS_PROXY: 'http://127.0.0.1:18086',
      NO_PROXY: 'localhost,127.0.0.1',
    },
  });
  assert.equal(fromEnvironment.proxyUrl.toString(), 'http://127.0.0.1:18086/');
  assert.equal(fromEnvironment.source, 'HTTPS_PROXY');

  const fromWindows = resolveSystemProxy('https://agentrouter.org/v1', {
    env: {},
    windowsSettings: {
      proxyEnabled: true,
      proxyServer: 'http=127.0.0.1:7890;https=127.0.0.1:7891',
    },
  });
  assert.equal(fromWindows.proxyUrl.toString(), 'http://127.0.0.1:7891/');
  assert.equal(fromWindows.source, 'Windows Internet Settings');
});

await run('inherits the primary API path for the official alternate domain', () => {
  const config = createConfig({
    UPSTREAM_BASE_URL: 'https://agentrouter.org/api/openai/v1',
  });
  assert.equal(config.upstreamFallbackBaseUrls.length, 1);
  assert.equal(
    config.upstreamFallbackBaseUrls[0].toString(),
    'https://ps.air-outer.com/api/openai/v1',
  );
});

console.info(`\n${passed} tests passed.`);
