import { createHash, randomBytes } from 'node:crypto';

const WINDOW = 20;
const SEGMENT_CAPACITY = 40_000;
const FALSE_POSITIVE_RATE = 1e-12;

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function stringsIn(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => stringsIn(item, output));
  return output;
}

function assertNoUnsafeValue(raw) {
  if (/(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}(?:\/|\b)|\b[A-Za-z]:\\|\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{12,}/.test(raw)) {
    throw new Error('Semantic result contains an unsafe path or credential-like value; generalize it before ingestion.');
  }
}

function digest(salt, value) {
  return createHash('sha256').update(`${salt}\u0000${value}`).digest();
}

function token(salt, value) {
  return digest(salt, value).subarray(0, 12).toString('base64url');
}

function positions(salt, value, bitCount, hashCount) {
  const bytes = digest(salt, value);
  const first = bytes.readUInt32BE(0);
  const second = (bytes.readUInt32BE(4) | 1) >>> 0;
  return Array.from({ length: hashCount }, (_, index) => (first + (index * second)) % bitCount);
}

function setBit(bytes, position) {
  bytes[position >> 3] |= 1 << (position & 7);
}

function hasBit(bytes, position) {
  return (bytes[position >> 3] & (1 << (position & 7))) !== 0;
}

function transcriptTexts(messages) {
  return (messages ?? [])
    .filter((message) => message?.role === 'user' || message?.role === 'assistant')
    .map((message) => normalize(message.text))
    .filter(Boolean);
}

function segmentShape(capacity = SEGMENT_CAPACITY) {
  const bitCount = Math.ceil((-capacity * Math.log(FALSE_POSITIVE_RATE)) / (Math.log(2) ** 2));
  return { capacity, bitCount, hashCount: Math.min(40, Math.max(1, Math.round((bitCount / capacity) * Math.log(2)))) };
}

function newSegment() {
  const shape = segmentShape();
  return {
    ...shape,
    itemCount: 0,
    bits: Buffer.alloc(Math.ceil(shape.bitCount / 8)).toString('base64'),
    phraseHashes: [],
    phraseLengths: [],
    exactHashes: []
  };
}

export function createPrivacyState(salt = randomBytes(16).toString('hex')) {
  return { schema: 'agent-insight/privacy-state-v3', salt, window: WINDOW, segments: [] };
}

export function addMessagesToPrivacyState(state, messages) {
  if (state?.schema !== 'agent-insight/privacy-state-v3') throw new Error('Invalid privacy state.');
  const texts = transcriptTexts(messages);
  const windowCount = texts.reduce((count, text) => count + Math.max(0, text.length - WINDOW + 1), 0);
  if (windowCount > SEGMENT_CAPACITY) throw new Error('A semantic task exceeded the privacy fingerprint safety limit.');
  let segment = state.segments.at(-1);
  if (!segment || segment.itemCount + windowCount > segment.capacity) {
    segment = newSegment();
    state.segments.push(segment);
  }
  const bits = Buffer.from(segment.bits, 'base64');
  const phrases = new Set(segment.phraseHashes);
  const phraseLengths = new Set(segment.phraseLengths);
  const exact = new Set(segment.exactHashes);
  for (const text of texts) {
    if (text.length < WINDOW) {
      exact.add(token(state.salt, text));
      if (text.length >= 6 && (/\s/.test(text) || /[0-9_/:@=-]/.test(text))) {
        phrases.add(token(state.salt, text));
        phraseLengths.add(text.length);
      }
      continue;
    }
    for (let index = 0; index + WINDOW <= text.length; index += 1) {
      for (const position of positions(state.salt, text.slice(index, index + WINDOW), segment.bitCount, segment.hashCount)) setBit(bits, position);
    }
  }
  segment.itemCount += windowCount;
  segment.bits = bits.toString('base64');
  segment.phraseHashes = [...phrases];
  segment.phraseLengths = [...phraseLengths].sort((left, right) => left - right);
  segment.exactHashes = [...exact];
  return state;
}

export function createPrivacyFingerprint(messages, salt = 'ephemeral-check') {
  return addMessagesToPrivacyState(createPrivacyState(salt), messages);
}

export function assertSafeDerivedOutput(value) {
  for (const raw of stringsIn(value)) assertNoUnsafeValue(raw);
}

export function assertNoRawOverlap(value, messagesOrState) {
  const state = messagesOrState?.schema === 'agent-insight/privacy-state-v3'
    ? messagesOrState
    : createPrivacyFingerprint(messagesOrState ?? []);
  for (const raw of stringsIn(value)) {
    assertNoUnsafeValue(raw);
    const text = normalize(raw);
    if (!text) continue;
    for (const segment of state.segments) {
      const exact = new Set(segment.exactHashes ?? []);
      if (exact.has(token(state.salt, text))) {
        throw new Error('Semantic result contains verbatim transcript overlap; paraphrase it before ingestion.');
      }
      const phrases = new Set(segment.phraseHashes ?? []);
      for (const length of segment.phraseLengths ?? []) {
        for (let index = 0; index + length <= text.length; index += 1) {
          if (phrases.has(token(state.salt, text.slice(index, index + length)))) {
            throw new Error('Semantic result contains verbatim transcript overlap; paraphrase it before ingestion.');
          }
        }
      }
      const bits = Buffer.from(segment.bits, 'base64');
      if (bits.length !== Math.ceil(segment.bitCount / 8)) throw new Error('Invalid privacy fingerprint.');
      for (let index = 0; index + state.window <= text.length; index += 1) {
        const candidate = positions(state.salt, text.slice(index, index + state.window), segment.bitCount, segment.hashCount);
        if (candidate.every((position) => hasBit(bits, position))) {
          throw new Error('Semantic result contains verbatim transcript overlap; paraphrase it before ingestion.');
        }
      }
    }
  }
}
