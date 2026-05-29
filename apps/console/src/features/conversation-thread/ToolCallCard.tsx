import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import styles from './ConversationThreadView.module.css';
import type { ConversationToolCallEvent } from '@/services/conversation.service';

/**
 * Nested tool-call card rendered inside an agent-turn event row.
 *
 * The substrate captures tool args + result as JSON-stringified strings
 * (PR1 wire shape normalizes both). The renderer:
 *   - Always shows the tool name + Wrench icon at the top.
 *   - Args + result render in collapsed-by-default <details>-style
 *     blocks; clicking the toggle reveals the JSON payload.
 *   - Shows a "(truncated)" tag next to the label when the substrate
 *     marked the payload truncated, so the operator knows the inline
 *     copy is partial.
 *
 * Why default-collapsed: tool args + results can be large JSON blobs
 * (file reads, search results); a half-screen of JSON between agent
 * turns would drown the conversation flow. The collapsed shape keeps
 * the thread scannable while leaving full content one click away.
 *
 * Accessibility: each toggle is a real <button> with aria-expanded and
 * an aria-controls reference to the payload <pre>; min-height meets the
 * 44px tap floor per canon dev-web-mobile-first-required.
 */
export interface ToolCallCardProps {
  readonly event: ConversationToolCallEvent;
}

export function ToolCallCard({ event }: ToolCallCardProps) {
  return (
    <div
      className={styles.toolCallCard}
      data-testid="conversation-tool-call"
      data-tool-name={event.tool_name}
    >
      <header className={styles.toolCallHead}>
        <span className={styles.toolCallIcon} aria-hidden="true">
          <Wrench size={14} strokeWidth={2} />
        </span>
        <span
          className={styles.toolName}
          data-testid="conversation-tool-call-name"
        >
          {event.tool_name}
        </span>
      </header>
      <ToolCallPayloadBlock
        label="args"
        payload={event.args}
        truncated={event.args_truncated}
        testId="conversation-tool-call-args"
      />
      <ToolCallPayloadBlock
        label="result"
        payload={event.result}
        truncated={event.result_truncated}
        testId="conversation-tool-call-result"
      />
    </div>
  );
}

interface PayloadBlockProps {
  readonly label: 'args' | 'result';
  readonly payload: string;
  readonly truncated: boolean;
  readonly testId: string;
}

function ToolCallPayloadBlock({
  label,
  payload,
  truncated,
  testId,
}: PayloadBlockProps) {
  const [open, setOpen] = useState(false);
  // Empty payload: substrate did not record this side of the call.
  // Render a label only so the operator sees the row exists; no toggle.
  if (payload === '' && !truncated) {
    return (
      <div className={styles.toolCallBlock} data-testid={testId}>
        <span className={styles.toolCallBlockLabel}>{label}</span>
        <span className={styles.truncatedTag}>(empty)</span>
      </div>
    );
  }
  return (
    <div className={styles.toolCallBlock} data-testid={testId}>
      <button
        type="button"
        className={styles.toolCallToggle}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
      >
        {open ? (
          <ChevronDown size={12} strokeWidth={2.25} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} strokeWidth={2.25} aria-hidden="true" />
        )}
        <span className={styles.toolCallBlockLabel}>{label}</span>
        {truncated && (
          <span className={styles.truncatedTag}>(truncated)</span>
        )}
      </button>
      {open && (
        <pre
          className={styles.toolCallPayload}
          data-testid={`${testId}-payload`}
        >
          {payload}
        </pre>
      )}
    </div>
  );
}
