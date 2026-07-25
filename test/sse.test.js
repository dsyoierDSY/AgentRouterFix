import test from 'node:test';
import assert from 'node:assert/strict';
import { isOutOfBandBillingEvent, SseEventFilter } from '../src/sse.js';

test('recognizes only the unsupported billing SSE event', () => {
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
  assert.equal(isOutOfBandBillingEvent('data: malformed\n\n'), false);
});

test('filters billing event even when its bytes arrive in partial chunks', () => {
  let drops = 0;
  const filter = new SseEventFilter({ onDrop: () => drops++ });
  const input = [
    'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"object":"billing.summary","billing":{"source":"request"}}\n\n',
    'data: [DONE]\n\n',
  ].join('');

  const encoded = new TextEncoder().encode(input);
  const pieces = [encoded.subarray(0, 35), encoded.subarray(35, 121), encoded.subarray(121)];
  const output = [];
  for (const piece of pieces) {
    const result = filter.push(piece);
    if (result) output.push(result);
  }
  const tail = filter.flush();
  if (tail) output.push(tail);

  const text = new TextDecoder().decode(Buffer.concat(output));
  assert.match(text, /chat\.completion\.chunk/);
  assert.match(text, /\[DONE\]/);
  assert.doesNotMatch(text, /billing\.summary/);
  assert.equal(drops, 1);
});

test('can preserve billing events while diagnosis mode is enabled', () => {
  const filter = new SseEventFilter({ dropBilling: false });
  const data = new TextEncoder().encode('data: {"object":"billing.summary"}\n\n');
  const output = filter.push(data);

  assert.match(new TextDecoder().decode(output), /billing\.summary/);
});
