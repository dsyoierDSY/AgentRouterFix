import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createConfig } from '../src/config.js';
import { applyHeaderProfile, extractSafeProfileHeaders } from '../src/header-profile.js';
import { createProxyServer } from '../src/server.js';
import { isOutOfBandBillingEvent, SseEventFilter } from '../src/sse.js';

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

console.info(`\n${passed} tests passed.`);
