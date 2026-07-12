import { createReadStream } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, extname } from 'node:path';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const SHORT_TURN_THRESHOLD = 40;
const CORRECTION_PATTERN = /(?:不对|别|不要|重(?:新|做)|停下|等等|错了|换|stop|no\b|wrong|redo|revert|undo|不行|不是)/i;
const LAST_TOOL_SEQUENCE_LIMIT = 10;

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

function embeddedContentTimestamp(record) {
  if (!isObject(record)) return null;
  const payload = isObject(record.payload) ? record.payload : null;
  const message = isObject(record.message) ? record.message : null;
  const item = record.type === 'response_item' && payload ? payload : message ?? payload ?? record;
  const text = contentText(isObject(item) ? item.content : null);
  const match = typeof text === 'string' ? text.match(/<timestamp>\s*([^<]+?)\s*<\/timestamp>/i) : null;
  return match ? normaliseDate(match[1].trim()) : null;
}

/** Prefer explicit JSON clocks; fall back to Cursor-style embedded <timestamp> tags. */
export function recordTimestamp(record) {
  if (!isObject(record)) return null;
  const candidates = [
    record.timestamp,
    record.createdAt,
    record.created_at,
    record.time,
    record.payload?.timestamp,
    record.payload?.createdAt,
    record.message?.timestamp,
    embeddedContentTimestamp(record)
  ];
  for (const candidate of candidates) {
    const date = normaliseDate(candidate);
    if (date) return date;
  }
  return null;
}

function firstDate(record) {
  return recordTimestamp(record);
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

const LANGUAGE_BY_EXTENSION = new Map([
  ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'], ['.js', 'JavaScript'], ['.jsx', 'JavaScript'],
  ['.py', 'Python'], ['.rb', 'Ruby'], ['.go', 'Go'], ['.rs', 'Rust'], ['.java', 'Java'],
  ['.c', 'C'], ['.h', 'C'], ['.cpp', 'C++'], ['.cc', 'C++'], ['.cxx', 'C++'],
  ['.hpp', 'C++'], ['.hh', 'C++'], ['.hxx', 'C++'], ['.ipp', 'C++'], ['.md', 'Markdown'],
  ['.json', 'JSON'], ['.yaml', 'YAML'], ['.yml', 'YAML'], ['.sh', 'Shell'], ['.css', 'CSS'],
  ['.html', 'HTML']
]);

function contentText(content, types = new Set(['text', 'input_text', 'output_text'])) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(isObject).filter((block) => types.has(String(block.type ?? '').toLowerCase())).map((block) => block.text ?? '').filter((text) => typeof text === 'string').join('\n');
}

function toolResultText(block) {
  return typeof block.content === 'string' ? block.content : null;
}

function classifyToolError(text) {
  const value = String(text ?? '').toLowerCase();
  if (value.includes('exit code')) return 'Command Failed';
  if (value.includes('rejected') || value.includes("doesn't want")) return 'User Rejected';
  if (value.includes('string to replace not found') || value.includes('no changes')) return 'Edit Failed';
  if (value.includes('modified since read')) return 'File Changed';
  if (value.includes('exceeds maximum') || value.includes('too large')) return 'File Too Large';
  if (value.includes('file not found') || value.includes('does not exist')) return 'File Not Found';
  return 'Other';
}

function lineDiffCounts(oldText, newText) {
  const oldLines = String(oldText ?? '').split('\n');
  const newLines = String(newText ?? '').split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const oldMiddle = oldLines.slice(prefix, oldEnd);
  const newMiddle = newLines.slice(prefix, newEnd);
  const maximum = oldMiddle.length + newMiddle.length;
  let editDistance = maximum;
  if (maximum > 0) {
    const offset = maximum + 1;
    const frontier = new Int32Array((maximum * 2) + 3);
    frontier[offset + 1] = 0;
    search: for (let distance = 0; distance <= maximum; distance += 1) {
      for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
        const index = offset + diagonal;
        let x = diagonal === -distance || (diagonal !== distance && frontier[index - 1] < frontier[index + 1])
          ? frontier[index + 1]
          : frontier[index - 1] + 1;
        let y = x - diagonal;
        while (x < oldMiddle.length && y < newMiddle.length && oldMiddle[x] === newMiddle[y]) {
          x += 1;
          y += 1;
        }
        frontier[index] = x;
        if (x >= oldMiddle.length && y >= newMiddle.length) {
          editDistance = distance;
          break search;
        }
      }
    }
  } else editDistance = 0;
  const middleCommon = (oldMiddle.length + newMiddle.length - editDistance) / 2;
  const common = prefix + (oldLines.length - oldEnd) + middleCommon;
  return { added: newLines.length - common, removed: oldLines.length - common };
}

function observeTool(session, name, input = {}) {
  const toolName = firstString(name, 'unknown');
  session.toolCalls += 1;
  increment(session.toolNames, toolName);
  session.lastToolSequence.push(toolName);
  if (session.lastToolSequence.length > LAST_TOOL_SEQUENCE_LIMIT) session.lastToolSequence.shift();
  const command = typeof input.command === 'string' ? input.command : '';
  if (command.includes('git commit')) session.gitCommits += 1;
  if (command.includes('git push')) session.gitPushes += 1;
  if (/^(Task|Agent)$/i.test(toolName)) session.usesTaskAgent = true;
  if (/^mcp__/i.test(toolName)) session.usesMcp = true;
  if (/^WebSearch$/i.test(toolName)) session.usesWebSearch = true;
  if (/^WebFetch$/i.test(toolName)) session.usesWebFetch = true;
  const filePath = firstString(input.file_path, input.filePath, input.path);
  if (filePath) increment(session.languages, LANGUAGE_BY_EXTENSION.get(extname(filePath).toLowerCase()));
  if (filePath && /^(Edit|Write)$/i.test(toolName)) session._modifiedFiles.add(filePath);
  if (/^Write$/i.test(toolName) && typeof input.content === 'string') session.linesAdded += input.content.split('\n').length;
  if (/^Edit$/i.test(toolName)) {
    const difference = lineDiffCounts(input.old_string, input.new_string);
    session.linesAdded += difference.added;
    session.linesRemoved += difference.removed;
  }
}

function countContentTools(content, session) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isObject(block)) continue;
    const type = String(block.type ?? '').toLowerCase();
    if (type === 'tool_result' && (block.is_error || block.error)) {
      session.toolErrors += 1;
      increment(session.toolErrorCategories, classifyToolError(toolResultText(block)));
      continue;
    }
    if (!/(tool_use|tool_call|toolcall|function_call)/.test(type)) continue;
    observeTool(session, firstString(block.name, block.tool_name, block.function?.name, 'unknown'), block.input ?? block.arguments ?? block.function?.arguments ?? {});
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
  const userText = contentText(item.content);
  const isUser = !isLifecycleEvent && Boolean(userText.trim()) && (role === 'user' || recordType === 'user' || itemType === 'user_message');
  const isAssistant = !isLifecycleEvent && (role === 'assistant' || recordType === 'assistant' || itemType === 'assistant_message');
  const timestamp = firstDate(record);
  if (isUser) {
    session.userMessages += 1;
    if (userText.length > 0 && userText.length <= SHORT_TURN_THRESHOLD) session.shortUserTurns += 1;
    if (CORRECTION_PATTERN.test(userText)) session.correctionTurns += 1;
    if (userText.includes('[Request interrupted by user')) session.userInterruptions += 1;
    if (timestamp) {
      session.userMessageTimestamps.push(timestamp);
      increment(session.messageHours, new Date(timestamp).getUTCHours());
      if (session._lastAssistantTimestamp) {
        const responseSeconds = (Date.parse(timestamp) - Date.parse(session._lastAssistantTimestamp)) / 1000;
        if (responseSeconds > 2 && responseSeconds < 3600) session.userResponseTimes.push(responseSeconds);
      }
    }
  }
  if (isAssistant) {
    session.assistantMessages += 1;
    if (timestamp) session._lastAssistantTimestamp = timestamp;
  }

  const isTool = /(tool_use|tool_call|toolcall|function_call|custom_tool_call|tool_search_call|web_search_call)/.test(itemType) || /^(tool_use|tool_call|toolcall|function_call|custom_tool_call|tool_search_call|web_search_call)$/.test(recordType);
  if (isTool) {
    observeTool(session, firstString(item.name, item.tool_name, item.function?.name, record.name, 'unknown'), item.input ?? item.arguments ?? item.function?.arguments ?? {});
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
    shortUserTurns: 0,
    correctionTurns: 0,
    lastToolSequence: [],
    languages: {},
    gitCommits: 0,
    gitPushes: 0,
    userInterruptions: 0,
    userResponseTimes: [],
    toolErrorCategories: {},
    usesTaskAgent: false,
    usesMcp: false,
    usesWebSearch: false,
    usesWebFetch: false,
    linesAdded: 0,
    linesRemoved: 0,
    filesModified: 0,
    messageHours: {},
    userMessageTimestamps: [],
    providers: {},
    models: {},
    partial: false,
    partialReason: null,
    recordsRead: 0,
    recognizedRecords: 0,
    malformedRecords: 0,
    hasBranches: false,
    parentCounts: {},
    _modifiedFiles: new Set(),
    _lastAssistantTimestamp: null
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
  for (const field of ['userMessages', 'assistantMessages', 'toolCalls', 'toolErrors', 'turnFailures', 'inputTokens', 'outputTokens', 'recordsRead', 'gitCommits', 'gitPushes', 'userInterruptions', 'linesAdded', 'linesRemoved', 'filesModified']) {
    session[field] = nonNegativeNumber(cached[field]);
  }
  session.toolNames = metadataCounts(cached.toolNames);
  session.languages = metadataCounts(cached.languages);
  session.toolErrorCategories = metadataCounts(cached.toolErrorCategories);
  session.messageHours = metadataCounts(cached.messageHours);
  session.userResponseTimes = Array.isArray(cached.userResponseTimes) ? cached.userResponseTimes.map(nonNegativeNumber) : [];
  session.userMessageTimestamps = Array.isArray(cached.userMessageTimestamps) ? cached.userMessageTimestamps.filter((value) => normaliseDate(value)).map(normaliseDate) : [];
  for (const field of ['usesTaskAgent', 'usesMcp', 'usesWebSearch', 'usesWebFetch']) session[field] = Boolean(cached[field]);
  session.providers = metadataCounts(cached.providers);
  session.models = metadataCounts(cached.models);
  session.partial = Boolean(cached.partial);
  session.partialReason = typeof cached.partialReason === 'string' ? cached.partialReason.slice(0, 128) : null;
  session.hasBranches = Boolean(cached.hasBranches);
  session.recognizedRecords = 1;
  return session;
}

export function claudeTopologyNode(record) {
  if (!isObject(record)) return null;
  const uuid = firstString(record.uuid);
  if (!uuid) return null;
  const payload = isObject(record.payload) ? record.payload : null;
  const message = isObject(record.message) ? record.message : null;
  const item = record.type === 'response_item' && payload ? payload : message ?? payload ?? record;
  const recordType = String(record.type ?? '').toLowerCase();
  const itemType = String(item.type ?? '').toLowerCase();
  const role = String(item.role ?? record.role ?? '').toLowerCase();
  const userText = contentText(item.content);
  const isUser = recordType !== 'event_msg'
    && Boolean(userText.trim())
    && (role === 'user' || recordType === 'user' || itemType === 'user_message');
  return {
    uuid,
    parentUuid: firstString(record.parentUuid),
    timestamp: firstDate(record),
    isUser
  };
}

function observeLine(session, line, { topology = null, selectedUuids = null } = {}) {
  if (!line.trim()) return;
  session.recordsRead += 1;
  try {
    const record = JSON.parse(line);
    const topologyNode = topology ? claudeTopologyNode(record) : null;
    if (topologyNode) topology.set(topologyNode.uuid, topologyNode);
    if ((!selectedUuids || selectedUuids.has(firstString(record.uuid))) && observeRecord(session, record)) {
      session.recognizedRecords += 1;
    }
  } catch {
    // A live transcript can end with a partial line; either way coverage must
    // reveal that this file was not completely understood.
    session.malformedRecords += 1;
    session.partial = true;
    session.partialReason ??= 'malformed_record';
  }
}

function sessionDurationMinutes(session) {
  const start = Date.parse(session.startedAt);
  const end = Date.parse(session.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? Math.round((end - start) / 60_000)
    : 0;
}

function chooseClaudeLeaf(current, incoming) {
  if (incoming.userMessages !== current.userMessages) {
    return incoming.userMessages > current.userMessages ? incoming : current;
  }
  return sessionDurationMinutes(incoming) > sessionDurationMinutes(current) ? incoming : current;
}

export function selectClaudeLeafUuids(nodes) {
  const referencedParents = new Set();
  for (const node of nodes.values()) if (node.parentUuid) referencedParents.add(node.parentUuid);
  const leaves = [...nodes.keys()].filter((uuid) => !referencedParents.has(uuid));
  if (leaves.length <= 1) return null;

  let selected = null;
  for (const leaf of leaves) {
    const uuids = [];
    const seen = new Set();
    let uuid = leaf;
    let startedAt = null;
    let endedAt = null;
    let userMessages = 0;
    while (uuid && nodes.has(uuid) && !seen.has(uuid)) {
      seen.add(uuid);
      uuids.push(uuid);
      const node = nodes.get(uuid);
      if (node.isUser) userMessages += 1;
      if (node.timestamp) {
        if (!startedAt || node.timestamp < startedAt) startedAt = node.timestamp;
        if (!endedAt || node.timestamp > endedAt) endedAt = node.timestamp;
      }
      uuid = node.parentUuid;
    }
    const candidate = { uuids, userMessages, startedAt, endedAt };
    selected = selected ? chooseClaudeLeaf(selected, candidate) : candidate;
  }
  return selected ? new Set(selected.uuids) : null;
}

async function parseJsonlPass(filePath, source, { fileSize, maxBytes, maxRecords, maxRecordBytes }, { topology = null, selectedUuids = null } = {}) {
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
      observeLine(session, line, { topology, selectedUuids });
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
    if (Buffer.byteLength(pending) <= maxRecordBytes) observeLine(session, pending, { topology, selectedUuids });
    else {
      session.partial = true;
      session.partialReason = 'record_limit';
    }
  }
  return session;
}

async function parseJsonl(filePath, source, limits) {
  if (source !== 'claude') return parseJsonlPass(filePath, source, limits);
  const topology = new Map();
  const aggregate = await parseJsonlPass(filePath, source, limits, { topology });
  const selectedUuids = selectClaudeLeafUuids(topology);
  topology.clear();
  if (!selectedUuids) return aggregate;

  const selected = await parseJsonlPass(filePath, source, limits, { selectedUuids });
  selected.recordsRead = aggregate.recordsRead;
  selected.recognizedRecords = aggregate.recognizedRecords;
  selected.malformedRecords = aggregate.malformedRecords;
  selected.partial = aggregate.partial;
  selected.partialReason = aggregate.partialReason;
  selected.hasBranches = true;
  return selected;
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
  session.filesModified ||= session._modifiedFiles.size;
  const boundedBeforeRecognition = session.partial && ['byte_limit', 'record_limit', 'event_limit'].includes(session.partialReason);
  if (session.recognizedRecords === 0 && !boundedBeforeRecognition) {
    throw new TranscriptParseError(`${basename(filePath)} did not contain a recognized session record.`);
  }
  delete session._fallbackId;
  delete session.parentCounts;
  delete session._modifiedFiles;
  delete session._lastAssistantTimestamp;
  return session;
}
