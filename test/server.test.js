import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConfig } from '../src/config.js';
import { createProxyServer } from '../src/server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

function quietLogger() {
  return { info() {}, debug() {}, error() {} };
}

test('filters billing summary and protects upstream key from local client', async (t) => {
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
  t.after(() => close(upstream));

  const config = createConfig({
    HOST: '127.0.0.1',
    PORT: '8787',
    UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    AGENTROUTER_API_KEY: 'upstream-secret',
    LOCAL_PROXY_API_KEY: 'local-secret',
    UPSTREAM_USER_AGENT: 'test-proxy/1.0',
    DROP_BILLING_SSE: 'true',
    LOG_LEVEL: 'error',
  });
  const proxy = createProxyServer(config, { logger: quietLogger() });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-secret',
      'content-type': 'application/json',
      'user-agent': 'CherryStudio/unknown',
    },
    body: '{"model":"kimi-k3","stream":true,"messages":[]}',
  });

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /chat\.completion\.chunk/);
  assert.match(text, /\[DONE\]/);
  assert.doesNotMatch(text, /billing\.summary/);
  assert.equal(receivedHeaders.authorization, 'Bearer upstream-secret');
  assert.equal(receivedHeaders['user-agent'], 'test-proxy/1.0');
});

test('returns a local 401 before calling the upstream when proxy key is wrong', async (t) => {
  let upstreamCalled = false;
  const upstream = http.createServer((_req, res) => {
    upstreamCalled = true;
    res.end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const config = createConfig({
    UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    LOCAL_PROXY_API_KEY: 'local-secret',
  });
  const proxy = createProxyServer(config, { logger: quietLogger() });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
    headers: { authorization: 'Bearer wrong' },
  });

  assert.equal(response.status, 401);
  assert.equal(upstreamCalled, false);
  assert.equal((await response.json()).error.type, 'authentication_error');
});

test('serves health check without requiring an API key', async (t) => {
  const config = createConfig({
    UPSTREAM_BASE_URL: 'https://example.test/v1',
    LOCAL_PROXY_API_KEY: 'local-secret',
  });
  const proxy = createProxyServer(config, { logger: quietLogger() });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const response = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: 'agentrouter-openai-compat',
  });
});
