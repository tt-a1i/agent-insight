// Only native execution fields are evidence of tool state. Tool output text
// may quote arbitrary files or instructions and must never supply that state.
const CALL_TYPES = new Set(['tool_use', 'tool_call', 'toolcall', 'function_call', 'custom_tool_call', 'tool_search_call', 'web_search_call']);
const RESULT_TYPES = new Set(['tool_result', 'toolresult', 'tool_call_output', 'function_call_output', 'custom_tool_call_output']);

export function toolEventKind(type) {
  const value = String(type ?? '').toLowerCase();
  return RESULT_TYPES.has(value) ? 'result' : CALL_TYPES.has(value) ? 'call' : null;
}

export function toolExecutionStatus(value) {
  const status = String(value?.state?.status ?? value?.status ?? '').toLowerCase();
  if (value?.is_error === true || value?.isError === true || value?.error || ['error', 'failed', 'denied', 'rejected', 'cancelled', 'canceled'].includes(status)) return 'failed';
  if (value?.is_error === false || value?.isError === false || ['completed', 'success', 'succeeded'].includes(status)) return 'succeeded';
  return 'unknown';
}

export function toolEventMetadata(value, kind, names = new Map()) {
  const callId = [value?.tool_use_id, value?.toolCallId, value?.call_id, kind === 'call' ? value?.id : null].find((candidate) => typeof candidate === 'string' && candidate.trim());
  const name = [value?.name, value?.tool_name, value?.toolName, value?.tool, value?.function?.name, callId ? names.get(callId) : null]
    .find((candidate) => typeof candidate === 'string' && candidate.trim()) ?? 'unknown';
  if (kind === 'call' && callId) names.set(callId, name);
  return { kind, name, ...(callId ? { callId } : {}), status: kind === 'call' ? 'unknown' : toolExecutionStatus(value) };
}
