import assert from 'node:assert/strict';
import test from 'node:test';

import { addMessagesToPrivacyState, assertNoRawOverlap, assertSafeDerivedOutput, createPrivacyState } from '../src/privacy.mjs';

test('privacy guard rejects verbatim transcript spans and short secret-like tokens', () => {
  const messages = [
    { role: 'user', text: 'Please preserve THIS_EXACT_PRIVATE_TOKEN_9123 and fix the broken authentication parser immediately.' }
  ];
  assert.throws(() => assertNoRawOverlap({ brief_summary: 'The user said THIS_EXACT_PRIVATE_TOKEN_9123.' }, messages), /verbatim transcript overlap/);
  assert.throws(() => assertNoRawOverlap({ detail: 'fix the broken authentication parser' }, messages), /verbatim transcript overlap/);
  assert.throws(() => assertNoRawOverlap({ detail: 'Inspect /Users/private/project/secret.ts next.' }, messages), /unsafe path or credential/);
  assert.doesNotThrow(() => assertNoRawOverlap({ brief_summary: 'Authentication parsing was repaired.' }, messages));
});

test('privacy checks reject short raw prompts without persistent probabilistic state', () => {
  assert.throws(() => assertNoRawOverlap(
    { brief_summary: 'fix login bug' },
    [{ role: 'user', text: 'fix login bug' }]
  ), /verbatim transcript overlap/);
  const state = createPrivacyState('scale-test');
  for (let batch = 0; batch < 4; batch += 1) {
    addMessagesToPrivacyState(state, Array.from({ length: 100 }, (_, index) => ({ role: 'user', text: `random transcript ${batch}-${index} ${'x'.repeat(190)}` })));
  }
  assert.ok(state.segments.length > 1);
  assert.doesNotThrow(() => assertNoRawOverlap({ brief_summary: 'Authentication behavior was corrected.' }, state));
  assert.throws(() => assertSafeDerivedOutput({ detail: 'Read /Users/private/project/secret.ts.' }), /unsafe path or credential/);
  assert.doesNotThrow(() => assertNoRawOverlap(
    { brief_summary: 'The agent progressed through a normal implementation.' },
    [{ role: 'user', text: 'i' }, { role: 'user', text: 'go' }, { role: 'user', text: 'ok' }]
  ));
  assert.throws(() => assertNoRawOverlap({ brief_summary: 'go' }, [{ role: 'user', text: 'go' }]), /verbatim transcript overlap/);
});
