import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { basename, extname } from 'node:path';
import { claudeTopologyNode, piTopologyNode, recordTimestamp, selectClaudeLeafUuids, selectPiBranchIds } from './parse.mjs';
import { authorshipCoverageNote, classifyAnalysisRole, genuineUserTextFromContent } from './authorship.mjs';
import { toolEventKind, toolEventMetadata } from './tool-events.mjs';
import { observeProjectMetadata } from './project-metadata.mjs';

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
}

function addMessage(messages, role, text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  messages.push({ index: messages.length + 1, role, text });
  return true;
}

function addToolMessage(state, value, kind) {
  const tool = toolEventMetadata(value, kind, state.toolNames);
  state.messages.push({ index: state.messages.length + 1, role: 'tool', text: tool.name, tool });
}

function collectAssistantOrTool(state, role, content) {
  const { messages } = state;
  if (typeof content === 'string') {
    addMessage(messages, role, content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const type = String(block.type ?? '').toLowerCase();
    if (['text', 'input_text', 'output_text'].includes(type)) addMessage(messages, role, block.text);
    const kind = toolEventKind(type);
    if (kind) addToolMessage(state, block, kind);
  }
}

function observeRecord(state, record, source) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : null;
  const message = record.message && typeof record.message === 'object' ? record.message : null;
  const item = record.type === 'response_item' && payload ? payload : message ?? payload ?? record;
  state.sessionId ??= firstString(record.sessionId, record.session_id, payload?.sessionId, payload?.session_id, record.type === 'session_meta' ? payload?.id : null, record.type === 'session' ? record.id : null);
  observeProjectMetadata(state, record);
  const timestamp = recordTimestamp(record, source);
  if (timestamp && !Number.isNaN(Date.parse(timestamp))) {
    const value = Date.parse(timestamp);
    state.firstTimestamp = state.firstTimestamp === null ? value : Math.min(state.firstTimestamp, value);
    state.lastTimestamp = state.lastTimestamp === null ? value : Math.max(state.lastTimestamp, value);
    if (!state.date) state.date = new Date(value).toISOString().slice(0, 10);
  }

  const classified = classifyAnalysisRole(record);
  if (classified.reason === 'lifecycle' || classified.reason === 'system_injection') return;
  const role = String(item.role ?? record.role ?? '').toLowerCase();
  const kind = role === 'toolresult' ? 'result' : toolEventKind(item.type);
  if (kind) {
    addToolMessage(state, item, kind);
    return;
  }
  if (classified.role === 'user') {
    if (Array.isArray(item.content) && item.content.some((block) => toolEventKind(block?.type) === 'result')) {
      let added = false;
      for (const block of item.content) {
        if (toolEventKind(block?.type) === 'result') addToolMessage(state, block, 'result');
        else added = addMessage(state.messages, 'user', genuineUserTextFromContent([block])) || added;
      }
      if (added) state.userMessageCount += 1;
    } else if (addMessage(state.messages, 'user', classified.text)) state.userMessageCount += 1;
    return;
  }
  if (classified.role === 'assistant') {
    collectAssistantOrTool(state, 'assistant', classified.content);
    if (source === 'pi' && ['error', 'aborted'].includes(item.stopReason)) {
      state.messages.push({ index: state.messages.length + 1, role: 'agent_event', text: '', agent: { status: item.stopReason === 'aborted' ? 'cancelled' : 'failed' } });
    }
    return;
  }
  if (classified.role === 'tool') {
    addToolMessage(state, item, 'call');
    return;
  }
  // Claude stores tool results in user-role envelopes without authored text.
  if (role === 'user' && Array.isArray(item.content)) {
    for (const block of item.content) if (toolEventKind(block?.type) === 'result') addToolMessage(state, block, 'result');
  }
}

function emptyState() {
  return { sessionId: null, project: null, projectPaths: [], date: null, messages: [], toolNames: new Map(), userMessageCount: 0, firstTimestamp: null, lastTimestamp: null };
}

async function readSnapshot(filePath, info, { maxRecords, maxRecordBytes, source, topologyOnly = false, topologySource = 'claude', selectedUuids = null, selectedIds = null } = {}) {
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
        const node = topologySource === 'pi' ? piTopologyNode(record) : claudeTopologyNode(record);
        if (node) topology.set(node.uuid, node);
      } else if ((!selectedUuids || selectedUuids.has(firstString(record.uuid))) && (!selectedIds || record.type === 'session' || selectedIds.has(firstString(record.id)))) {
        observeRecord(state, record, source);
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
  let selectedIds = null;
  let expectedHash = null;
  if (source === 'claude') {
    const topologyPass = await readSnapshot(filePath, info, { maxRecords, maxRecordBytes, topologyOnly: true });
    selectedUuids = selectClaudeLeafUuids(topologyPass.topology);
    expectedHash = topologyPass.contentHash;
  } else if (source === 'pi') {
    const topologyPass = await readSnapshot(filePath, info, { maxRecords, maxRecordBytes, topologyOnly: true, topologySource: 'pi' });
    selectedIds = selectPiBranchIds(topologyPass.topology);
    expectedHash = topologyPass.contentHash;
  }
  const snapshot = await readSnapshot(filePath, info, { maxRecords, maxRecordBytes, source, selectedUuids, selectedIds });
  if (expectedHash && snapshot.contentHash !== expectedHash) throw new Error('Transcript changed between semantic projection passes; retry from a fresh run.');
  const { state } = snapshot;
  if (state.messages.length === 0) throw new Error('Transcript contains no analyzable user or assistant messages.');
  const sessionKey = state.sessionId ?? basename(filePath, extname(filePath));
  const coverageNote = authorshipCoverageNote(source);
  return {
    source,
    sessionId: sessionKey,
    opaqueId: createHash('sha256').update(`${source}\u0000${sessionKey}`).digest('hex').slice(0, 24),
    contentHash: snapshot.contentHash,
    date: state.date,
    projectPath: state.project ?? null,
    projectPaths: state.projectPaths,
    projectLabel: state.project ? basename(state.project.replace(/[\\/]+$/, '')) : 'unknown',
    userMessageCount: state.userMessageCount,
    durationMinutes: state.firstTimestamp === null || state.lastTimestamp === null ? 0 : Math.round((state.lastTimestamp - state.firstTimestamp) / 60_000),
    messages: state.messages,
    authorship: {
      filter: 'genuine-user-v1',
      coverageNote
    }
  };
}
