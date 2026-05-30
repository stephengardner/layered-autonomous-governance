import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeToPipelineStream } from '@/services/pipelines.service';

/**
 * Per-pipeline SSE subscription for the Conversation Thread surface.
 *
 * The Conversation Thread is a projection over the same atom set that
 * the pipeline detail surface reads from. The substrate's pipeline SSE
 * channel (`/api/events/pipeline.<id>`) broadcasts `atom-change` events
 * for every atom that lands tied to the pipeline. The pipeline detail
 * view (`usePipelineStream`) already invalidates its TanStack Query
 * cache on each atom-change so the operator sees a new agent-turn or
 * stage transition within a frame instead of waiting for the next
 * 10s poll.
 *
 * This hook is the conversation-scope counterpart. It opens the SAME
 * EventSource via the same `subscribeToPipelineStream` seam and
 * invalidates BOTH conversation query keys:
 *
 *   - `['conversation', 'pipeline', pipelineId]`
 *   - `['conversation', 'plan', planId]` when supplied
 *
 * `pipelineId` may be null when the operator is on a plan-scope
 * conversation that has not yet resolved a linked pipeline (e.g. an
 * orphan deliberation atom). The hook safely no-ops in that case; the
 * 10s polling fallback covers the gap until the pipeline is resolved
 * and the consumer re-renders with a non-null id.
 *
 * Why this is NOT a usePipelineStream pass-through:
 *
 *   - usePipelineStream invalidates `['pipeline', pipelineId]` (root
 *     detail) + `['pipeline-error-state', pipelineId]`. The
 *     conversation query keys live under a different prefix; a single
 *     hook cannot fan out both invalidations cleanly without a public
 *     API change.
 *   - Mounting BOTH hooks (pipeline-stream + conversation-stream) on
 *     the same view is intentional: each consumer owns its own
 *     invalidate signal. The transport seam de-dupes the underlying
 *     EventSource per query, so two subscribers do not open two
 *     connections.
 *
 * Connection-state surfacing is intentionally omitted from the return
 * type: the Conversation Thread view does not render a "live" pill
 * (the chronological feed itself is the operator's progress signal),
 * and the 10s polling fallback covers the SSE-failed case implicitly.
 * A future telemetry surface can read connection state from the
 * separate `usePipelineStream` hook if needed.
 *
 * Mirrors `useEffect`-for-observers per Console canon
 * `dev-web-no-useeffect-for-data` (an EventSource is an observer, not
 * a data fetch; the cache invalidation is a push-side write).
 */
export function useConversationStream(
  pipelineId: string | null,
  planId: string | null,
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!pipelineId) return undefined;

    let unsubscribe: (() => void) | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      try {
        unsubscribe = subscribeToPipelineStream(pipelineId, {
          onOpen: () => {
            /*
             * No connection-state UI; the fallback poll keeps the
             * operator's view fresh even if SSE never opens.
             */
          },
          onAtomChange: () => {
            /*
             * Any atom-change tied to this pipeline can affect the
             * conversation projection: a new agent-turn, a new
             * stage-event, a new audit-finding, a dispatch-result
             * settling, an actor-message landing. Invalidate the
             * conversation query so the projection re-fetches.
             *
             * Invalidating with `['conversation', 'pipeline', id]`
             * fans out via prefix-match to any future
             * `['conversation', 'pipeline', id, ...]` keys the
             * service might add. The same applies to the plan
             * scope's prefix when supplied.
             */
            void queryClient.invalidateQueries({
              queryKey: ['conversation', 'pipeline', pipelineId],
            });
            if (planId) {
              void queryClient.invalidateQueries({
                queryKey: ['conversation', 'plan', planId],
              });
            }
          },
          onPipelineStateChange: () => {
            /*
             * Pipeline state-change events also affect the
             * conversation projection: a state transition often
             * lands alongside a stage-event atom whose atom-change
             * event already fired the invalidate above. The double
             * invalidate is cheap (TanStack de-dupes in-flight
             * fetches), but kept explicit so a future substrate
             * change that decouples the two signals does not silently
             * drop conversation freshness.
             */
            void queryClient.invalidateQueries({
              queryKey: ['conversation', 'pipeline', pipelineId],
            });
            if (planId) {
              void queryClient.invalidateQueries({
                queryKey: ['conversation', 'plan', planId],
              });
            }
          },
          onError: () => {
            if (disposed) return;
            unsubscribe?.();
            unsubscribe = null;
            /*
             * SSE failed; the 10s polling fallback in the view's
             * useQuery is the safety net. Surfacing reconnection
             * here would duplicate the work usePipelineStream already
             * does on the sibling pipeline-detail surface; mounting
             * both hooks gives the operator both signal paths.
             */
          },
        });
      } catch {
        /*
         * EventSource construction itself failed. Same posture: the
         * polling fallback covers correctness; we do not retry here
         * because there is no per-conversation-view telemetry that
         * benefits from the retry signal.
         */
      }
    };

    connect();

    return () => {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
    };
  }, [pipelineId, planId, queryClient]);
}
