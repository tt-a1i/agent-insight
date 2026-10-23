import { createHash } from 'node:crypto';

/** Read-only identity and navigation model; never infer claim-to-message support. */
export function buildEvidenceIndex(report) {
  const entries = new Map();
  const metadata = report.semantic?.sessions ?? [];
  const contexts = report.parity?.evidenceContext?.sessions ?? [];
  for (const session of [...metadata, ...contexts]) {
    if (session.id == null) continue;
    const id = String(session.id);
    if (!entries.has(id)) entries.set(id, { id, session: {}, grounding: [], conflict: false });
    const entry = entries.get(id);
    if (entry.session.source && session.source && entry.session.source !== session.source) entry.conflict = true;
    for (const [key, value] of Object.entries(session)) {
      if (key !== 'grounding' && entry.session[key] == null) entry.session[key] = value;
    }
  }
  for (const context of contexts) {
    const entry = entries.get(String(context.id));
    if (entry) entry.grounding.push(...(context.grounding ?? []));
  }
  const aliases = new Map();
  for (const entry of entries.values()) {
    const alias = String(entry.session.sessionId ?? entry.id);
    if (!aliases.has(alias)) aliases.set(alias, new Set());
    aliases.get(alias).add(entry.id);
  }
  const resolve = (reference) => {
    const id = String(reference);
    if (entries.has(id)) {
      const entry = entries.get(id);
      return entry.conflict ? { status: 'ambiguous' } : { status: 'resolved', entry };
    }
    const ids = aliases.get(id);
    if (!ids?.size) return { status: 'missing' };
    if (ids.size !== 1) return { status: 'ambiguous' };
    const entry = entries.get([...ids][0]);
    return entry.conflict ? { status: 'ambiguous' } : { status: 'resolved', entry };
  };
  const anchor = (entry) => `evidence-session-${createHash('sha256').update(entry.id).digest('hex')}`;
  const groundingAnchor = (entry, index) => `${anchor(entry)}-item-${index + 1}`;
  const auditTarget = (locator, quotations = []) => {
    const resolved = resolve(locator.sessionId);
    if (resolved.status !== 'resolved') return null;
    const { entry } = resolved;
    // Only link an exact single-message quotation match. A multi-message
    // grounding does not identify which message supplied its quotation.
    const indexes = [...new Set(locator.messageIndexes ?? [])];
    if (indexes.length !== 1) return null;
    const index = entry.grounding.findIndex((item) => item.messageIndexes?.length === 1
      && item.messageIndexes[0] === indexes[0] && item.quotation
      && quotations.some((quote) => quote && (item.quotation.includes(quote) || quote.includes(item.quotation))));
    return index < 0 ? null : groundingAnchor(entry, index);
  };
  return { entries: [...entries.values()], resolve, anchor, groundingAnchor, auditTarget };
}
