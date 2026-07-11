import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { basename, extname } from 'node:path';
import { claudeTopologyNode, selectClaudeLeafUuids } from './parse.mjs';

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
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

function emptyState() {
  return { sessionId: null, project: null, date: null, messages: [], userMessageCount: 0, firstTimestamp: null, lastTimestamp: null };
}

async function readSnapshot(filePath, info, { maxRecords, maxRecordBytes, topologyOnly = false, selectedUuids = null } = {}) {
  const state = emptyState();
  const topology = topologyOnly ? new Map() : null;
  const hash = createHash('sha256');
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  const input = createReadStream(filePath, { end: Math.max(0, info.size - 1) }).pipe(hashingStream);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let records = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    records += 1;
    if (records > maxRecords) throw new Error(`Transcript exceeds the ${maxRecords} record semantic limit.`);
    if (Buffer.byteLength(line) > maxRecordBytes) throw new Error('Transcript contains a record above the semantic record-size limit.');
    try {
      const record = JSON.parse(line);
      if (topology) {
        const node = claudeTopologyNode(record);
        if (node) topology.set(node.uuid, node);
      } else if (!selectedUuids || selectedUuids.has(firstString(record.uuid))) {
        observeRecord(state, record);
      }
    } catch {
      // Coverage and parse diagnostics are handled by the collection pass.
    }
  }
  const finalInfo = await lstat(filePath);
  if (finalInfo.size !== info.size || finalInfo.mtimeMs !== info.mtimeMs) throw new Error('Transcript changed during semantic extraction; retry from a fresh run.');
  return { state, topology, contentHash: hash.digest('hex') };
}

export async function extractAnalysisInput(file, source, {
  maxBytes = 16 * 1024 * 1024,
  maxRecords = 100_000,
  maxRecordBytes = 2 * 1024 * 1024
} = {}) {
  const filePath = file instanceof URL ? fileURLToPath(file) : String(file);
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) throw new Error('Refusing symbolic-link transcript.');
  if (info.size > maxBytes) throw new Error(`Transcript exceeds the ${Math.round(maxBytes / 1024 / 1024 * 10) / 10} MiB semantic byte limit.`);
  if (extname(filePath).toLowerCase() !== '.jsonl') throw new Error('Semantic transcript extraction currently requires JSONL.');
  let selectedUuids = null;
  let expectedHash = null;
  if (source === 'claude') {
    const topologyPass = await readSnapshot(filePath, info, { maxRecords, maxRecordBytes, topologyOnly: true });
    selectedUuids = selectClaudeLeafUuids(topologyPass.topology);
    expectedHash = topologyPass.contentHash;
  }
  const snapshot = await readSnapshot(filePath, info, { maxRecords, maxRecordBytes, selectedUuids });
  if (expectedHash && snapshot.contentHash !== expectedHash) throw new Error('Transcript changed between semantic projection passes; retry from a fresh run.');
  const { state } = snapshot;
  if (state.messages.length === 0) throw new Error('Transcript contains no analyzable user or assistant messages.');
  const sessionKey = state.sessionId ?? basename(filePath, extname(filePath));
  return {
    source,
    sessionId: sessionKey,
    opaqueId: createHash('sha256').update(`${source}\u0000${sessionKey}`).digest('hex').slice(0, 24),
    contentHash: snapshot.contentHash,
    date: state.date,
    projectLabel: state.project ? basename(state.project.replace(/[\\/]+$/, '')) : 'unknown',
    userMessageCount: state.userMessageCount,
    durationMinutes: state.firstTimestamp === null || state.lastTimestamp === null ? 0 : Math.round((state.lastTimestamp - state.firstTimestamp) / 60_000),
    messages: state.messages
  };
}
