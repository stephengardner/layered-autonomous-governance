/**
 * Local time-format helper for the conversation-thread feature.
 *
 * Mirrors the shape of `formatRelative` exported from
 * `apps/console/src/features/pipelines-viewer/PipelinesView.tsx`. The
 * Console has a single canonical relative-time helper (used by 15+
 * features); we deliberately do NOT back-import it here to avoid a
 * circular module dependency:
 *
 *   PipelinesView -> ConversationThreadView -> ConversationEvent -> PipelinesView
 *
 * The cycle resolves in ESM (functions are hoisted), but it widens the
 * blast radius of any future refactor that splits PipelinesView. Per
 * canon dev-extract-at-second-instance (the 'rule of two'), this is
 * the second consumer of the helper inside a feature folder; instead
 * of folding it back into a shared util (which would touch every one
 * of the 15 existing call-sites), we keep a 6-line local copy so the
 * dependency graph stays acyclic. A future refactor pass that does
 * extract the canonical helper into apps/console/src/lib/ should
 * delete this file and have every feature import from there.
 */
export function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const ageSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  // Floor within each bucket so a boundary-adjacent value cannot
  // overflow into the next bucket's range (e.g. ageSec = 3599 with
  // Math.round would render '60m ago' instead of crossing into the
  // 1.0h-ago bucket). The bucket-cap check (`< 3600`) already gates
  // the input; floor keeps the rendered label within the bucket.
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86_400) {
    const hours = Math.floor((ageSec / 3600) * 10) / 10;
    return `${hours.toFixed(1)}h ago`;
  }
  return new Date(ts).toLocaleString();
}
