import assert from 'node:assert/strict';
import test from 'node:test';
import { splitSessionMessages } from '../src/protocol.mjs';

test('oversized messages retain every character and original evidence index in bounded JSON chunks', () => {
  const messages = [
    { index: 1, role: 'user', text: `Start ${'"\\\n\u0000😀'.repeat(10_000)}Do not deploy.` },
    { index: 2, role: 'assistant', text: `${'Working. '.repeat(10_000)}Tests failed.` },
    { index: 3, role: 'user', text: 'Please report the failure.' }
  ];
  const original = structuredClone(messages);
  const chunks = splitSessionMessages(messages);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => JSON.stringify(chunk).length <= 25_000));
  for (const message of messages) {
    const parts = chunks.flat().filter((part) => part.index === message.index);
    assert.ok(parts.every((part) => part.role === message.role));
    assert.equal(parts.map((part) => part.text).join(''), message.text);
    assert.ok(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part.text) && !/^[\uDC00-\uDFFF]/.test(part.text)));
  }
  assert.deepEqual(messages, original);
});

test('small chunk limits fail explicitly or preserve complete Unicode characters', () => {
  const message = { index: 1, role: 'user', text: '😀😀tail' };
  const overhead = JSON.stringify([{ ...message, text: '' }]).length;
  const chunks = splitSessionMessages([message], overhead + 2);
  assert.equal(chunks.flat().map((part) => part.text).join(''), message.text);
  assert.ok(chunks.every((chunk) => JSON.stringify(chunk).length <= overhead + 2));
  assert.throws(() => splitSessionMessages([message], overhead + 1), /too small/);
  assert.throws(() => splitSessionMessages([message], Infinity), /chunk limit/);
  assert.throws(() => splitSessionMessages([{ index: 1, role: 'user', text: '', extra: 'x'.repeat(100) }], 50), /too small/);
});

test('fitting adjacent messages never exceed the serialized array budget', () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({ index: index + 1, role: 'user', text: 'same-sized request' }));
  const budget = JSON.stringify(messages.slice(0, 2)).length;
  const chunks = splitSessionMessages(messages, budget);
  assert.ok(chunks.every((chunk) => JSON.stringify(chunk).length <= budget));
  assert.deepEqual(chunks.flat(), messages);
});
