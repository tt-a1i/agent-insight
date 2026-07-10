import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { basename, extname } from 'node:path';

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function addMessage(messages, role, text, limit) {
  if (typeof text !== 'string' || !text.trim()) return;
  messages.push({ index: messages.length + 1, role, text: text.trim().slice(0, limit) });
}

function collectContent(messages, role, content) {
  const limit = role === 'user' ? 500 : 300;
  if (typeof content === 'string') {
    addMessage(messages, role, content, limit);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const type = String(block.type ?? '').toLowerCase();
    if (['text', 'input_text', 'output_text'].includes(type)) addMessage(messages, role, block.text, limit);
    if (/(tool_use|tool_call|function_call|custom_tool_call)/.test(type)) {
      addMessage(messages, 'tool', firstString(block.name, block.tool_name, block.function?.name, 'unknown'), 120);
    }
  }
}

function observeRecord(state, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : null;
  const message = record.message && typeof record.message === 'object' ? record.message : null;
  const item = record.type === 'response_item' && payload ? payload : message ?? payload ?? record;
  state.sessionId ??= firstString(record.sessionId, record.session_id, payload?.sessionId, payload?.session_id, record.type === 'session_meta' ? payload?.id : null);
  state.project ??= firstString(record.cwd, record.projectPath, record.project_path, record.workspace, payload?.cwd, item.cwd);
  const timestamp = firstString(record.timestamp, payload?.timestamp, message?.timestamp);
  if (timestamp && !Number.isNaN(Date.parse(timestamp))) {
    const value = Date.parse(timestamp);
    state.firstTimestamp = state.firstTimestamp === null ? value : Math.min(state.firstTimestamp, value);
    state.lastTimestamp = state.lastTimestamp === null ? value : Math.max(state.lastTimestamp, value);
    if (!state.date) state.date = new Date(value).toISOString().slice(0, 10);
  }

  const role = String(item.role ?? record.role ?? '').toLowerCase();
  if (role === 'user' || role === 'assistant') {
    const before = state.messages.length;
    collectContent(state.messages, role, item.content);
    if (role === 'user' && state.messages.slice(before).some((entry) => entry.role === 'user')) state.userMessageCount += 1;
  }
  const itemType = String(item.type ?? '').toLowerCase();
  if (/(tool_use|tool_call|function_call|custom_tool_call)/.test(itemType)) {
    addMessage(state.messages, 'tool', firstString(item.name, item.tool_name, item.function?.name, 'unknown'), 120);
  }
}

export async function extractAnalysisInput(file, source) {
  const filePath = file instanceof URL ? fileURLToPath(file) : String(file);
  if ((await lstat(filePath)).isSymbolicLink()) throw new Error('Refusing symbolic-link transcript.');
  if (extname(filePath).toLowerCase() !== '.jsonl') throw new Error('Semantic transcript extraction currently requires JSONL.');
  const state = { sessionId: null, project: null, date: null, messages: [], userMessageCount: 0, firstTimestamp: null, lastTimestamp: null };
  const lines = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      observeRecord(state, JSON.parse(line));
    } catch {
      // Coverage and parse diagnostics are handled by the collection pass.
    }
  }
  if (state.messages.length === 0) throw new Error('Transcript contains no analyzable user or assistant messages.');
  const sessionKey = state.sessionId ?? basename(filePath, extname(filePath));
  return {
    source,
    opaqueId: createHash('sha256').update(`${source}\u0000${sessionKey}`).digest('hex').slice(0, 24),
    contentHash: await hashFile(filePath),
    date: state.date,
    projectLabel: state.project ? basename(state.project.replace(/[\\/]+$/, '')) : 'unknown',
    userMessageCount: state.userMessageCount,
    durationMinutes: state.firstTimestamp === null || state.lastTimestamp === null ? 0 : Math.round((state.lastTimestamp - state.firstTimestamp) / 60_000),
    messages: state.messages
  };
}
