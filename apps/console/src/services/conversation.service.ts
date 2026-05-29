/**
 * Conversation service: wraps POST /api/pipelines.conversation +
 * POST /api/deliberations.conversation.
 *
 * Two scopes, one wire-shape envelope per scope. The frontend picks the
 * scope at call-time via a discriminated `ConversationScope` so the
 * route-aware view (PipelineDetailView's "Conversation" subroute vs
 * DeliberationView's "Conversation" subroute) calls the right endpoint
 * without mixing handler logic.
 *
 * Wire-shape types live in `apps/console/server/conversation-types.ts`
 * (PR1) and are re-exported here so callers do not import server code
 * directly. Mirrors `pipelines.service.ts` pattern.
 *
 * Substrate purity: every call is a read; the substrate writes the
 * underlying atoms (operator-intent + pipeline-stage-event + agent-turn
 * + actor-message + pipeline-cross-stage-reprompt + brainstorm-output +
 * spec-output + review-report + dispatch-record + code-author-invoked).
 * No new atom types per `arch-atomstore-source-of-truth`.
 */

import { transport } from './transport';

export type {
  ConversationContentBody,
  ConversationDispatchOutcome,
  ConversationDeliberationResult,
  ConversationEvent,
  ConversationEventKind,
  ConversationEventSeverity,
  ConversationOperatorIntentEvent,
  ConversationStageStartedEvent,
  ConversationAgentPromptEvent,
  ConversationAgentResponseEvent,
  ConversationToolCallEvent,
  ConversationInterAgentMessageEvent,
  ConversationCrossStageRepromptEvent,
  ConversationStageOutputEvent,
  ConversationAuditFindingEvent,
  ConversationDispatchResultEvent,
  ConversationPipelineResult,
} from '../../server/conversation-types';

import type {
  ConversationDeliberationResult,
  ConversationPipelineResult,
} from '../../server/conversation-types';

/**
 * Discriminated scope for the conversation lookup. One side is keyed on
 * the pipeline atom id; the other on a plan atom id. The plan-keyed path
 * is the "deliberation" surface and the server resolves the underlying
 * pipeline (when one is linked) before assembling.
 */
export type ConversationScope =
  | { readonly pipeline_id: string }
  | { readonly plan_id: string };

/**
 * Result envelope for either scope. The shapes share `intent_id` +
 * `events`; the pipeline path always carries `pipeline_id` of the
 * pipeline atom, the plan path always carries `plan_id` of the plan
 * atom + an optional `pipeline_id` for the resolved pipeline (null
 * when the plan has no linked pipeline).
 */
export type ConversationResult =
  | ConversationPipelineResult
  | ConversationDeliberationResult;

/**
 * Fetch the conversation thread for the given scope.
 *
 * The function is the single backend entry-point the React hook below
 * uses. Splitting the two endpoints out as separate exports would
 * double the surface for no win; the scope-switch is one line and the
 * result-envelope shapes are structurally compatible at the renderer.
 *
 * Server-side errors surface as thrown Errors (HttpTransport unwraps
 * `{ ok: false }` and rethrows with the substrate-canonical error
 * code as the message). The 404 `pipeline-not-found` is the only
 * routinely-expected error and renderer call-sites discriminate on
 * `Error.message.includes('pipeline-not-found')`.
 */
export async function getConversation(
  scope: ConversationScope,
  signal?: AbortSignal,
): Promise<ConversationResult> {
  if ('pipeline_id' in scope) {
    return transport.call<ConversationPipelineResult>(
      'pipelines.conversation',
      { pipeline_id: scope.pipeline_id },
      signal ? { signal } : undefined,
    );
  }
  return transport.call<ConversationDeliberationResult>(
    'deliberations.conversation',
    { plan_id: scope.plan_id },
    signal ? { signal } : undefined,
  );
}
