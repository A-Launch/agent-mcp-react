// The conversation as this page holds it, and the reducer that folds the agent's event stream into it.
//
// Kept apart from rendering because the folding is where the interesting rule lives: a `tool_result`
// arrives as its own event, some time after the `tool_call` it belongs to, and the two must land in
// ONE entry. Appending them separately would show a person a list of calls and a list of results and
// leave matching them up as an exercise — which is exactly the part worth seeing.
//
// This module decides nothing about what to call. It records what happened.

/** What a transcript entry is. A closed set; the renderer branches on these and nothing else. */
export const ENTRY = {
  person: 'person',
  agent: 'agent',
  status: 'status',
  call: 'call',
  failure: 'failure',
} as const;

export type EntryKind = (typeof ENTRY)[keyof typeof ENTRY];

export interface CallResult {
  readonly ok: boolean;
  readonly text: string;
}

export interface Entry {
  readonly key: string;
  readonly kind: EntryKind;
  /** Present for person, agent, status and failure entries. */
  readonly text?: string;
  /** Present for call entries. */
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  /** Filled in when the matching `tool_result` arrives. Undefined means still running. */
  readonly result?: CallResult;
  /** The model's id for a call, used to match its result. Not shown. */
  readonly callId?: string;
}

let sequence = 0;
function nextKey(): string {
  sequence += 1;
  return `e${String(sequence)}`;
}

export function personSaid(text: string): Entry {
  return { key: nextKey(), kind: ENTRY.person, text };
}

export function failed(text: string): Entry {
  return { key: nextKey(), kind: ENTRY.failure, text };
}

/**
 * Folds one agent event into the transcript.
 *
 * Returns a new array, always — the caller stores it in React state, and mutating in place would
 * leave the page rendering a list React has no reason to believe changed.
 */
export function fold(
  entries: readonly Entry[],
  event: { readonly event: string; readonly data: Record<string, unknown> },
): readonly Entry[] {
  const { data } = event;

  if (event.event === 'message') {
    return [...entries, { key: nextKey(), kind: ENTRY.agent, text: String(data.text ?? '') }];
  }

  if (event.event === 'status') {
    // Only the newest status is kept. A turn emits one per round trip and they are progress, not
    // history — accumulating them would bury the tool calls that matter.
    const withoutStatus = entries.filter((entry) => entry.kind !== ENTRY.status);
    return [
      ...withoutStatus,
      { key: nextKey(), kind: ENTRY.status, text: String(data.text ?? '') },
    ];
  }

  if (event.event === 'tool_call') {
    const withoutStatus = entries.filter((entry) => entry.kind !== ENTRY.status);
    return [
      ...withoutStatus,
      {
        key: nextKey(),
        kind: ENTRY.call,
        name: String(data.name ?? '(unnamed)'),
        args: (data.arguments ?? {}) as Record<string, unknown>,
        callId: String(data.id ?? ''),
      },
    ];
  }

  if (event.event === 'tool_result') {
    const callId = String(data.id ?? '');
    const result: CallResult = { ok: data.ok === true, text: String(data.text ?? '') };
    let matched = false;
    const updated = entries.map((entry) => {
      if (matched || entry.kind !== ENTRY.call || entry.callId !== callId) return entry;
      matched = true;
      return { ...entry, result };
    });
    // A result whose call is not in the transcript is a real anomaly rather than something to drop:
    // it means the two streams disagree, and a person should be able to see that they do.
    return matched
      ? updated
      : [...updated, failed(`a result arrived for a call this page never saw: ${result.text}`)];
  }

  if (event.event === 'error') {
    const withoutStatus = entries.filter((entry) => entry.kind !== ENTRY.status);
    return [...withoutStatus, failed(String(data.message ?? 'the agent reported an error'))];
  }

  if (event.event === 'done') {
    return entries.filter((entry) => entry.kind !== ENTRY.status);
  }

  return [...entries, failed(`the agent sent an event this page does not know: ${event.event}`)];
}
