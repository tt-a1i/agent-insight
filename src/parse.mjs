import { createReadStream } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, extname } from 'node:path';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class TranscriptLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TranscriptLimitError';
    this.code = 'TRANSCRIPT_LIMIT';
  }
}

export class TranscriptParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TranscriptParseError';
    this.code = 'TRANSCRIPT_PARSE';
  }
}

function normaliseDate(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstDate(record) {
  const candidates = [
    record.timestamp,
    record.createdAt,
    record.created_at,
    record.time,
    record.payload?.timestamp,
    record.payload?.createdAt,
    record.message?.timestamp
  ];
  for (const candidate of candidates) {
    const date = normaliseDate(candidate);
    if (date) return date;
  }
  return null;
}

function firstString(...candidates) {
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim() ?? null;
}

function addDate(session, value) {
  if (!value) return;
  if (!session.startedAt || value < session.startedAt) session.startedAt = value;
  if (!session.endedAt || value > session.endedAt) session.endedAt = value;
}

function increment(object, key, amount = 1) {
  if (!key) return;
  object[key] = (object[key] ?? 0) + amount;
}

function countContentTools(content, session) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isObject(block)) continue;
    const type = String(block.type ?? '').toLowerCase();
    if (type === 'tool_result' && (block.is_error || block.error)) {
      session.toolErrors += 1;
      continue;
    }
    if (!/(tool_use|tool_call|toolcall|function_call)/.test(type)) continue;
    session.toolCalls += 1;
    increment(session.toolNames, firstString(block.name, block.tool_name, block.function?.name, 'unknown'));
    if (block.is_error || block.error) session.toolErrors += 1;
  }
}

function observeRecord(session, record) {
  if (!isObject(record)) return false;
  addDate(session, firstDate(record));

  const payload = isObject(record.payload) ? record.payload : null;
  const message = isObject(record.message) ? record.message : null;
  const item = record.type === 'response_item' && payload ? payload : message ?? payload ?? record;
  const recordType = String(record.type ?? '').toLowerCase();
  const itemType = String(item.type ?? '').toLowerCase();
  const role = String(item.role ?? record.role ?? '').toLowerCase();

  const id = firstString(
    record.sessionId,
    record.session_id,
    payload?.sessionId,
    payload?.session_id,
    recordType === 'session_meta' ? payload?.session_id : null,
    recordType === 'session_meta' ? payload?.id : null
  );
  if (id && session.id === session._fallbackId) session.id = id;
  else if (id && id !== session.id) {
    // A Codex bundle can contain root and subagent metadata. This lightweight
    // parser deliberately does not guess event ownership across those threads.
    session.partial = true;
    session.partialReason ??= 'multi_session_bundle';
  }

  const project = firstString(
    record.cwd,
    record.projectPath,
    record.project_path,
    record.workspace,
    payload?.cwd,
    payload?.projectPath,
    payload?.project_path,
    item.cwd
  );
  if (project) session.project = project;
  if (record.parentId) {
    session.parentCounts[record.parentId] = (session.parentCounts[record.parentId] ?? 0) + 1;
    if (session.parentCounts[record.parentId] > 1) session.hasBranches = true;
  }

  // Codex records both event_msg.user_message and response_item.message. The
  // former is lifecycle telemetry; counting it would double-count a user turn.
  const isLifecycleEvent = recordType === 'event_msg';
  const isUser = !isLifecycleEvent && (role === 'user' || recordType === 'user' || itemType === 'user_message');
  const isAssistant = !isLifecycleEvent && (role === 'assistant' || recordType === 'assistant' || itemType === 'assistant_message');
  if (isUser) session.userMessages += 1;
  if (isAssistant) session.assistantMessages += 1;

  const isTool = /(tool_use|tool_call|toolcall|function_call|custom_tool_call|tool_search_call|web_search_call)/.test(itemType) || /^(tool_use|tool_call|toolcall|function_call|custom_tool_call|tool_search_call|web_search_call)$/.test(recordType);
  if (isTool) {
    session.toolCalls += 1;
    increment(session.toolNames, firstString(item.name, item.tool_name, item.function?.name, record.name, 'unknown'));
  } else {
    countContentTools(item.content, session);
  }

  const status = String(item.status ?? record.status ?? '').toLowerCase();
  const failed = Boolean(item.is_error || item.error || record.error) || ['error', 'failed', 'denied'].includes(status);
  if (failed && isTool) session.toolErrors += 1;
  else if (failed && recordType === 'turn_ended') session.turnFailures += 1;

  const usage = item.usage ?? record.usage ?? payload?.usage;
  if (isObject(usage)) {
    session.inputTokens += Number(usage.input_tokens ?? usage.inputTokens ?? 0) || 0;
    session.outputTokens += Number(usage.output_tokens ?? usage.outputTokens ?? 0) || 0;
  }
  increment(session.providers, firstString(item.provider, payload?.provider, item.model?.provider, record.provider));
  increment(session.models, firstString(item.model, payload?.model, item.model?.id, record.model));
  return isUser || isAssistant || isTool || [
    'session',
    'session_meta',
    'response_item',
    'turn_ended',
    'model_change',
    'thinking_level_change',
    'compaction',
    'branch_summary',
    'custom',
    'custom_message'
  ].includes(recordType);
}

function emptySession(filePath, source) {
  const fallbackId = basename(filePath, extname(filePath));
  return {
    id: fallbackId,
    _fallbackId: fallbackId,
    source,
    project: null,
    startedAt: null,
    endedAt: null,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: 0,
    turnFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolNames: {},
    providers: {},
    models: {},
    partial: false,
    partialReason: null,
    recordsRead: 0,
    recognizedRecords: 0,
    malformedRecords: 0,
    hasBranches: false,
    parentCounts: {}
  };
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function metadataCounts(value) {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, count]) => typeof key === 'string' && key.length <= 256 && Number.isFinite(Number(count)) && Number(count) > 0)
    .map(([key, count]) => [key, Number(count)]));
}

function importSnapshotSession(document, filePath, source) {
  if (document?.schema !== 'agent-insight/import-v1' || !isObject(document.session)) return null;
  const cached = document.session;
  const session = emptySession(filePath, source);
  session.id = firstString(cached.id) ?? session.id;
  session.project = null;
  session.startedAt = normaliseDate(cached.startedAt);
  session.endedAt = normaliseDate(cached.endedAt);
  for (const field of ['userMessages', 'assistantMessages', 'toolCalls', 'toolErrors', 'turnFailures', 'inputTokens', 'outputTokens', 'recordsRead']) {
    session[field] = nonNegativeNumber(cached[field]);
  }
  session.toolNames = metadataCounts(cached.toolNames);
  session.providers = metadataCounts(cached.providers);
  session.models = metadataCounts(cached.models);
  session.partial = Boolean(cached.partial);
  session.partialReason = typeof cached.partialReason === 'string' ? cached.partialReason.slice(0, 128) : null;
  session.hasBranches = Boolean(cached.hasBranches);
  session.recognizedRecords = 1;
  return session;
}

function observeLine(session, line) {
  if (!line.trim()) return;
  session.recordsRead += 1;
  try {
    if (observeRecord(session, JSON.parse(line))) session.recognizedRecords += 1;
  } catch {
    // A live transcript can end with a partial line; either way coverage must
    // reveal that this file was not completely understood.
    session.malformedRecords += 1;
    session.partial = true;
    session.partialReason ??= 'malformed_record';
  }
}

async function parseJsonl(filePath, source, { fileSize, maxBytes, maxRecords, maxRecordBytes }) {
  const session = emptySession(filePath, source);
  const bytesToRead = Math.min(fileSize, maxBytes);
  if (fileSize > maxBytes) {
    session.partial = true;
    session.partialReason = 'byte_limit';
  }
  const stream = createReadStream(filePath, { encoding: 'utf8', end: Math.max(0, bytesToRead - 1), highWaterMark: 64 * 1024 });
  let pending = '';
  let discardingOversizeLine = false;
  for await (const chunk of stream) {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (discardingOversizeLine || Buffer.byteLength(line) > maxRecordBytes) {
        session.partial = true;
        session.partialReason ??= 'record_limit';
        discardingOversizeLine = false;
        continue;
      }
      observeLine(session, line);
      if (session.recordsRead >= maxRecords) {
        session.partial = true;
        session.partialReason = 'event_limit';
        stream.destroy();
        break;
      }
    }
    if (pending.length > maxRecordBytes) {
      // Do not let a huge tool output without a newline become an unbounded
      // readline buffer. Discard until the next record boundary.
      pending = '';
      discardingOversizeLine = true;
      session.partial = true;
      session.partialReason ??= 'record_limit';
    }
    if (session.partialReason === 'event_limit') break;
  }
  if (!session.partial && pending.trim()) {
    if (Buffer.byteLength(pending) <= maxRecordBytes) observeLine(session, pending);
    else {
      session.partial = true;
      session.partialReason = 'record_limit';
    }
  }
  return session;
}

function observeJsonDocument(session, document) {
  if (Array.isArray(document)) {
    for (const record of document) {
      session.recordsRead += 1;
      if (observeRecord(session, record)) session.recognizedRecords += 1;
    }
    return;
  }
  if (!isObject(document)) return;
  session.recordsRead += 1;
  if (observeRecord(session, document)) session.recognizedRecords += 1;
  const records = document.messages ?? document.items ?? document.events ?? document.data;
  if (Array.isArray(records)) {
    for (const record of records) {
      session.recordsRead += 1;
      if (observeRecord(session, record)) session.recognizedRecords += 1;
    }
  }
}

async function parseJson(filePath, source) {
  const session = emptySession(filePath, source);
  let document;
  try {
    document = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new TranscriptParseError(`${basename(filePath)} is not valid JSON.`);
  }
  const snapshot = importSnapshotSession(document, filePath, source);
  if (snapshot) return snapshot;
  observeJsonDocument(session, document);
  return session;
}

async function parseMarkdown(filePath, source) {
  const session = emptySession(filePath, source);
  const content = await readFile(filePath, 'utf8');
  const userHeadings = content.match(/^#{1,6}\s*(user|you)\b/gim) ?? [];
  const assistantHeadings = content.match(/^#{1,6}\s*(assistant|cursor|claude|agent)\b/gim) ?? [];
  session.userMessages = userHeadings.length;
  session.assistantMessages = assistantHeadings.length;
  session.recordsRead = userHeadings.length + assistantHeadings.length;
  session.recognizedRecords = session.recordsRead;
  return session;
}

/**
 * Normalises a transcript into metadata only. Raw prompt, tool output, and code
 * never leave this function or appear in returned objects.
 */
export async function parseSessionFile(file, source, {
  maxBytes = 16 * 1024 * 1024,
  maxRecords = 100_000,
  maxRecordBytes = 2 * 1024 * 1024
} = {}) {
  const filePath = file instanceof URL ? fileURLToPath(file) : String(file);
  const extension = extname(filePath).toLowerCase();
  if ((await lstat(filePath)).isSymbolicLink()) throw new Error(`Refusing symbolic-link transcript: ${basename(filePath)}`);
  const fileStat = await stat(filePath);
  if (fileStat.size > maxBytes && extension !== '.jsonl') {
    throw new TranscriptLimitError(`${basename(filePath)} exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB per-file limit.`);
  }
  let session;
  if (extension === '.jsonl') session = await parseJsonl(filePath, source, { fileSize: fileStat.size, maxBytes, maxRecords, maxRecordBytes });
  else if (extension === '.json') session = await parseJson(filePath, source);
  else if (extension === '.md' || extension === '.markdown') session = await parseMarkdown(filePath, source);
  else return null;

  const fallback = fileStat.mtime.toISOString();
  session.startedAt ??= fallback;
  session.endedAt ??= fallback;
  const boundedBeforeRecognition = session.partial && ['byte_limit', 'record_limit', 'event_limit'].includes(session.partialReason);
  if (session.recognizedRecords === 0 && !boundedBeforeRecognition) {
    throw new TranscriptParseError(`${basename(filePath)} did not contain a recognized session record.`);
  }
  delete session._fallbackId;
  delete session.parentCounts;
  return session;
}
