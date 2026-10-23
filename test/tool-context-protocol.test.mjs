import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionChunkRequest, createSessionFacetRequest, validateSessionChunkResult } from '../src/protocol.mjs';
import { createSessionAuditChunkRequest, createSessionAuditRequest } from '../src/audit-protocol.mjs';

test('direct and chunk analysis preserve tool result status without forwarding result bodies', () => {
  const tool = { kind: 'result', name: 'Bash', callId: 'call-7', status: 'failed' };
  const input = {
    source: 'claude', sessionId: 'tool-context', opaqueId: 'tool-context',
    messages: [
      { index: 1, role: 'user', text: 'Run the regression tests before proposing a fix.' },
      { index: 2, role: 'tool', text: 'Bash', tool: { ...tool, input: 'PRIVATE_ARGUMENTS', output: 'PRIVATE_RESULT' }, result: 'PRIVATE_TOP_LEVEL_RESULT' },
      { index: 3, role: 'agent_event', text: '', agent: { status: 'cancelled', errorMessage: 'PRIVATE_ERROR_BODY' } }
    ]
  };
  for (const request of [createSessionFacetRequest(input), createSessionChunkRequest(input, input.messages, 0, 1)]) {
    const messages = JSON.parse(request.prompt.match(/<transcript-json>\n([\s\S]*?)\n<\/transcript-json>/)[1]);
    assert.deepEqual(messages[1], { index: 2, role: 'tool', text: 'Bash', tool });
    assert.deepEqual(messages[2], { index: 3, role: 'agent_event', text: '', agent: { status: 'cancelled' } });
    assert.doesNotMatch(request.prompt, /PRIVATE_ARGUMENTS|PRIVATE_RESULT|PRIVATE_TOP_LEVEL_RESULT|PRIVATE_ERROR_BODY/);
    assert.match(request.prompt, /not proof that the user goal/);
  }
  for (const audit of [createSessionAuditRequest(input), createSessionAuditChunkRequest(input, input.messages, 0, 1)]) {
    assert.match(audit.prompt, /Run the regression tests/);
    const messages = JSON.parse(audit.prompt.match(/<interaction-json>\n([\s\S]*?)\n<\/interaction-json>/)[1]);
    assert.deepEqual(messages[1], { index: 2, role: 'tool', text: 'Bash', tool });
    assert.deepEqual(messages[2], { index: 3, role: 'agent_event', text: '', agent: { status: 'cancelled' } });
    assert.doesNotMatch(audit.prompt, /PRIVATE_ARGUMENTS|PRIVATE_RESULT|PRIVATE_TOP_LEVEL_RESULT|PRIVATE_ERROR_BODY/);
  }
  const observation = {
    summary: 'The tool failed and the turn was cancelled.',
    evidence: [{ message_indexes: [2, 3], description: 'Structured tool failure and cancellation.' }]
  };
  assert.equal(validateSessionChunkResult(observation, input).evidence[0].quotation, null);
  assert.throws(() => validateSessionChunkResult({ ...observation,
    evidence: [{ message_indexes: [2], description: 'Not dialogue.', quotation: 'Bash' }]
  }, input), /quotation does not match/);
});
