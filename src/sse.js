/**
 * Returns true only for the known AgentRouter accounting event that cannot be
 * parsed as an OpenAI chat completion chunk by strict clients.
 */
export function isOutOfBandBillingEvent(sseEvent) {
  const data = sseEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');

  if (!data || data === '[DONE]') return false;

  try {
    const payload = JSON.parse(data);
    return Boolean(
      payload &&
      typeof payload === 'object' &&
      (payload.object === 'billing.summary' ||
        (payload.billing &&
          !Array.isArray(payload.choices) &&
          !payload.error &&
          payload.object !== 'chat.completion.chunk')),
    );
  } catch {
    // Broken JSON should remain visible to the client instead of being hidden.
    return false;
  }
}

/**
 * Splits an SSE byte stream into full event blocks without changing the bytes
 * of valid events. This is important for clients that depend on SSE framing.
 */
export class SseEventFilter {
  constructor({ dropBilling = true, onDrop = () => {} } = {}) {
    this.dropBilling = dropBilling;
    this.onDrop = onDrop;
    this.pending = '';
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
  }

  push(chunk) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    return this.#consumeCompleteEvents();
  }

  flush() {
    this.pending += this.decoder.decode();
    const tail = this.pending;
    this.pending = '';

    // A proxy must not silently discard a non-conforming final partial event.
    return tail ? this.encoder.encode(tail) : null;
  }

  #consumeCompleteEvents() {
    const blocks = [];
    const splitter = /\r?\n\r?\n/;
    let match;

    while ((match = splitter.exec(this.pending))) {
      const end = match.index + match[0].length;
      const event = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);

      if (this.dropBilling && isOutOfBandBillingEvent(event)) {
        this.onDrop();
      } else {
        blocks.push(event);
      }
    }

    return blocks.length ? this.encoder.encode(blocks.join('')) : null;
  }
}
