import { createConfig, loadDotEnv } from './config.js';
import { createProxyServer } from './server.js';

loadDotEnv();

try {
  const config = createConfig();
  const server = createProxyServer(config);

  server.listen(config.port, config.host, () => {
    console.info(`AgentRouter compatibility proxy listening on http://${config.host}:${config.port}`);
    console.info(`Upstream: ${config.upstreamBaseUrl.origin}${config.upstreamBaseUrl.pathname}`);
    if (config.upstreamFallbackBaseUrls.length) {
      console.info(
        `Alternate upstream: ${config.upstreamFallbackBaseUrls
          .map((url) => `${url.origin}${url.pathname}`)
          .join(', ')}`,
      );
    }
    console.info(
      `System proxy fallback: ${config.systemProxyFallback ? 'enabled' : 'disabled'}`,
    );
    console.info(`Billing SSE filtering: ${config.dropBillingSse ? 'enabled' : 'disabled'}`);
  });

  function stop(signal) {
    console.info(`Received ${signal}; shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  }
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exitCode = 1;
}
