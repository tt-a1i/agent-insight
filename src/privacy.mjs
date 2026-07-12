/**
 * Content-privacy filtering was removed (Issue #2 / parent #1).
 * Reports may persist representative quotations, project paths, agent identity,
 * dates, and session identifiers. Filesystem and parser safety remain enforced
 * in transcript, parse, report-write, and install paths — not here.
 */

export function contentPrivacyEnabled() {
  return false;
}
