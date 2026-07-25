import http from 'node:http';
import { Readable } from 'node:stream';
import {
  applyHeaderProfile,
  FALLBACK_OPENCODE_HEADERS,
  isOpenCodeRequest,
  loadHeaderProfile,
  saveHeaderProfile,
} from './header-profile.js';
import { SseEventFilter } from './sse.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function createLogger(level) {
  const enabled = level === 'debug';
  return {
    info: (message) => console.info(`INFO ${message}`),
    debug: (message) => {
      if (enabled) console.info(`DEBUG ${message}`);
    },
    error: (message) => console.error(`ERROR ${message}`),
  };
}

function sendJson(response, status, body) {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    'cache-control': 'no-store',
  });
  response.end(serialized);
}

function requestPath(req) {
  const incoming = new URL(req.url ?? '/', 'http://local-proxy');
  // Client APIs conventionally use /v1. The upstream base already includes
  // its own version prefix if it needs one, so avoid producing /v1/v1.
  const path = incoming.pathname.replace(/^\/v1(?=\/|$)/, '') || '/';
  return `${path}${incoming.search}`;
}

function isOpenAiCompatiblePath(url) {
  const pathname = new URL(url ?? '/', 'http://local-proxy').pathname;
  return (
    pathname === '/v1' ||
    pathname.startsWith('/v1/') ||
    ['/models', '/chat/completions', '/responses', '/embeddings', '/audio', '/images', '/files'].some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  );
}

function upstreamUrl(config, req) {
  const base = config.upstreamBaseUrl.toString().replace(/\/$/, '');
  return new URL(`${base}${requestPath(req)}`);
}

function inboundHeadersToUpstream(req, config, logger) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  if (isOpenCodeRequest(req.headers)) {
    try {
      saveHeaderProfile(config.openCodeHeaderProfileFile, req.headers);
      logger.info('Captured OpenCode header profile for Cherry Studio compatibility.');
    } catch (error) {
      logger.error(`Could not save OpenCode header profile: ${error.message}`);
    }
  } else if (config.cherryUseOpenCodeProfile) {
    let profile = null;
    try {
      profile = loadHeaderProfile(config.openCodeHeaderProfileFile);
    } catch (error) {
      logger.error(error.message);
    }
    applyHeaderProfile(headers, profile ?? FALLBACK_OPENCODE_HEADERS);
    logger.debug(`Applied ${profile ? 'captured' : 'fallback'} OpenCode header profile.`);
  }
  return headers;
}

function upstreamHeadersToClient(headers, isSse) {
  const result = {};
  for (const [name, value] of headers.entries()) {
    if (
      HOP_BY_HOP_HEADERS.has(name.toLowerCase()) ||
      name.toLowerCase() === 'content-length' ||
      name.toLowerCase() === 'content-encoding'
    ) {
      continue;
    }
    result[name] = value;
  }
  if (isSse) {
    result['cache-control'] = 'no-cache, no-transform';
    result['x-accel-buffering'] = 'no';
  }
  return result;
}

function isSse(response) {
  return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream');
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Client aborted the request.')));
  });
}

async function pipeSse(upstreamResponse, clientResponse, config, logger) {
  const filter = new SseEventFilter({
    dropBilling: config.dropBillingSse,
    onDrop: () => logger.info('Dropped out-of-band billing.summary SSE event.'),
  });

  for await (const chunk of Readable.fromWeb(upstreamResponse.body)) {
    const output = filter.push(chunk);
    if (output) clientResponse.write(output);
  }
  const tail = filter.flush();
  if (tail) clientResponse.write(tail);
  clientResponse.end();
}

function localAuthorizationAllowed(req, config) {
  if (!config.localProxyApiKey) return true;
  return req.headers.authorization === `Bearer ${config.localProxyApiKey}`;
}

/**
 * Creates, but does not start, the local OpenAI-compatible proxy.
 */
export function createProxyServer(config, { fetchImpl = fetch, logger = createLogger(config.logLevel) } = {}) {
  return http.createServer(async (req, res) => {
    if (req.url === '/healthz' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, service: 'agentrouter-openai-compat' });
    }

    if (!isOpenAiCompatiblePath(req.url)) {
      return sendJson(res, 404, {
        error: {
          message: 'Use an OpenAI-compatible API path such as /v1/chat/completions.',
          type: 'invalid_request_error',
        },
      });
    }

    if (!localAuthorizationAllowed(req, config)) {
      return sendJson(res, 401, {
        error: {
          message: 'Invalid local proxy API key.',
          type: 'authentication_error',
        },
      });
    }

    let body;
    try {
      body = await getBody(req);
      const response = await fetchImpl(upstreamUrl(config, req), {
        method: req.method,
        headers: inboundHeadersToUpstream(req, config, logger),
        body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body,
        redirect: 'manual',
      });

      const responseIsSse = isSse(response);
      res.writeHead(response.status, upstreamHeadersToClient(response.headers, responseIsSse));
      logger.debug(`${req.method} ${req.url} -> ${response.status}${responseIsSse ? ' (SSE)' : ''}`);

      if (!response.body) return res.end();
      if (responseIsSse) return await pipeSse(response, res, config, logger);

      for await (const chunk of Readable.fromWeb(response.body)) res.write(chunk);
      res.end();
    } catch (error) {
      if (res.headersSent) {
        logger.error(`Upstream stream failed: ${error.message}`);
        return res.destroy(error);
      }
      logger.error(`Upstream request failed: ${error.message}`);
      return sendJson(res, 502, {
        error: {
          message: 'Local proxy could not reach the configured upstream.',
          type: 'api_connection_error',
        },
      });
    }
  });
}
