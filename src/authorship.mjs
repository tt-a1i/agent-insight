/**
 * Distinguishes genuine user-authored natural language from machine-injected
 * records before semantic projection. Deterministic metrics keep Claude-compatible
 * counting; this filter only shapes the audit/analysis transcript surface.
 */

const MACHINE_ONLY_TAGS = [
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'local-command',
  'environment_context',
  'env_context',
  'timestamp'
];

// These are transport wrappers only at a message boundary. The same strings
// inside prose, quotes, or fenced code are user content, not authorship metadata.
// Stop at the first closing tag: a suffix search must never expand one wrapper
// through intervening author text to reach a later wrapper with the same name.
const MACHINE_WRAPPER = `<(${MACHINE_ONLY_TAGS.join('|')})(?:\\s[^>]*)?(?:\\/>|>(?:(?!<\\/\\1>)[\\s\\S])*<\\/\\1>)`;
const PREFIX_MACHINE_WRAPPER_RE = new RegExp(`^\\s*${MACHINE_WRAPPER}(?:[ \\t]*\\r?\\n|$)`, 'i');
const SUFFIX_MACHINE_WRAPPER_RE = new RegExp(`(?:^|\\r?\\n)[ \\t]*${MACHINE_WRAPPER}\\s*$`, 'i');
const INTERRUPT_RE = /^\s*\[Request interrupted by user[^\]]*\]\s*/i;
const FILLER_ONLY_RE = /^(continue|ok|yes|y|n|no|thanks|thank you|请继续|继续|好的|可以)\s*[.。!！？]*$/i;

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
}

function stripMachineMarkup(text) {
  let value = String(text ?? '');
  let previous;
  do {
    previous = value;
    value = value.replace(PREFIX_MACHINE_WRAPPER_RE, '').replace(SUFFIX_MACHINE_WRAPPER_RE, '');
  } while (value !== previous);
  return value;
}

function looksLikeInjectedInstructionBlob(text) {
  const value = String(text ?? '');
  if (!value) return false;
  // Codex injects repository instructions using this complete envelope. A
  // document title or a natural-language mention alone cannot prove authorship.
  if (/^\s*#\s+AGENTS\.md instructions(?: for[^\r\n]*)?\r?\n\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>\s*$/i.test(value)) return true;
  if (/^\s*<(agents(?:_|\s|-)?instructions?)\b[^>]*>[\s\S]*<\/\1>\s*$/i.test(value)) return true;
  return false;
}

export function extractGenuineUserText(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw;
  if (INTERRUPT_RE.test(text)) {
    text = text.replace(INTERRUPT_RE, '').trim();
    if (!text || FILLER_ONLY_RE.test(text)) return null;
  }
  text = stripMachineMarkup(text);
  if (!text.trim()) return null;
  if (looksLikeInjectedInstructionBlob(text)) return null;
  return text;
}

export function recordIsMachineLifecycle(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return true;
  const recordType = String(record.type ?? '').toLowerCase();
  if (recordType === 'event_msg' || recordType === 'system' || recordType === 'progress') return true;
  if (record.isMeta === true || record.isCompactSummary === true) return true;
  return false;
}

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block && typeof block === 'object');
}

export function genuineUserTextFromContent(content) {
  const blocks = contentBlocks(content);
  if (blocks.length === 0) return null;
  const textParts = [];
  for (const block of blocks) {
    const type = String(block.type ?? '').toLowerCase();
    if (type === 'tool_result') continue;
    if (!['text', 'input_text', 'output_text'].includes(type)) continue;
    const genuine = extractGenuineUserText(block.text);
    if (genuine) textParts.push(genuine);
  }
  const text = textParts.join('\n');
  return text.trim() ? text : null;
}

export function classifyAnalysisRole(record) {
  if (recordIsMachineLifecycle(record)) return { role: null, reason: 'lifecycle' };
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : null;
  const message = record.message && typeof record.message === 'object' ? record.message : null;
  const item = record.type === 'response_item' && payload ? payload : message ?? payload ?? record;
  const role = String(item.role ?? record.role ?? '').toLowerCase();
  const recordType = String(record.type ?? '').toLowerCase();
  const itemType = String(item.type ?? '').toLowerCase();

  if (role === 'system' || role === 'developer') return { role: null, reason: 'system_injection' };
  if (/(tool_use|tool_call|function_call|custom_tool_call)/.test(itemType)) {
    return { role: 'tool', name: firstString(item.name, item.tool_name, item.function?.name, 'unknown') };
  }
  if (role === 'assistant' || recordType === 'assistant' || itemType === 'assistant_message') {
    return { role: 'assistant', content: item.content };
  }
  if (role === 'user' || recordType === 'user' || itemType === 'user_message') {
    const text = genuineUserTextFromContent(item.content);
    if (!text) return { role: null, reason: 'non_user_authored' };
    return { role: 'user', text };
  }
  return { role: null, reason: 'unsupported' };
}

export function authorshipCoverageNote(source) {
  if (source === 'cursor') {
    return 'Cursor authorship filtering is experimental: private formats may mix injected context with user text, so some non-user content may still reach semantic analysis.';
  }
  return null;
}
