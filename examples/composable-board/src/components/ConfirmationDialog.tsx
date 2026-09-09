import type { ConfirmationRequest } from 'agent-mcp-react';
import { CONFIRMATION, type ConfirmationDecision } from 'agent-mcp-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

// The surface a person actually decides on, for tools that declare `confirmation: 'required'`.
//
// **This is a COPY of `examples/customer-dashboard/src/components/ConfirmationDialog.tsx`, and the
// duplication is named rather than hidden.** Examples do not import each other — each consumes the
// library exactly as an embedder does — and the alternative was writing a weaker dialog here, which
// would have demonstrated the wrong pattern in the file an embedder is most likely to copy. Everything
// below is why it is not a five-line resolver: it shows what is being approved, closes itself when the
// call goes away, treats dismissal as refusal, and traps a keyboard.
//
// **What the second copy is evidence OF, recorded so it is not just tolerated:** two demonstrators have
// now needed the same 150 lines to make `permissions.confirmation` usable. That is the signal that the
// library may owe embedders a confirmation surface of its own. Shipping one is a change under `src/`,
// which this feature has forbidden itself, so it is raised as a follow-up rather than taken here.
//
// **This is the file an embedder copies, and that is why it is a real dialog.** A resolver that
// returned `'approved'` would make every case in this application pass and would convert the one place
// an author went out of their way to ask for a person into unconditional consent — silently, in the
// deployment that copied it. There is no shortcut here and there should not be one.
//
// What it demonstrates beyond "a modal appears":
//
//   - **It shows what is being approved**, from the snapshot the library hands over — the tool's title
//     and its already-validated arguments. A dialog that says only "the agent wants to do something"
//     is a dialog people click through.
//   - **It closes itself when the call goes away.** The request carries a signal that aborts when the
//     agent cancels or the tool stops being declared. A prompt left on screen for a call nobody is
//     waiting for is the one that gets approved by mistake ten minutes later.
//   - **Dismissing is refusing.** Escape, the backdrop and the close button all deny. The library
//     treats anything that is not an approval as a refusal, and this surface must not be the place
//     that turns "I did not decide" into "yes".
//   - **It is modal for a keyboard, not only in its ARIA.** Focus moves in, stays in, and goes back
//     where it came from. `aria-modal` is a claim about behaviour; the behaviour is below.
//
// It holds one request at a time. A second call arriving while a prompt is open waits its turn rather
// than replacing it, because a person answering a question they can no longer see is worse than an
// agent waiting.

/** One call waiting for an answer, and the two ways to give it. */
interface Pending {
  readonly request: ConfirmationRequest;
  readonly decide: (decision: ConfirmationDecision) => void;
}

export interface ConfirmationSurface {
  /** Hand to `AgentMcpProvider`'s `confirmation` prop. */
  readonly resolver: (request: ConfirmationRequest) => Promise<ConfirmationDecision>;
  /** Render inside the application, anywhere. */
  readonly dialog: ReactNode;
  /**
   * Whether a prompt is on screen.
   *
   * Published so the application can mark the rest of the page `inert` while a decision is pending.
   * A focus trap keeps a keyboard inside the dialog; `inert` is what also takes the background out of
   * the accessibility tree, so a screen reader is not free to browse the page behind a question it
   * has not answered. Neither alone makes a dialog modal.
   */
  readonly open: boolean;
}

/**
 * What a keyboard can land on inside the dialog, in document order.
 *
 * `:not([disabled])` matters even though nothing in this dialog is disabled today: a disabled control
 * matches `button` but cannot take focus, so if it were first or last the trap would call `focus()` on
 * it, nothing would move, and Tab would fall through to the page — the trap failing silently in the
 * one situation it exists for.
 */
const FOCUSABLE =
  'button:not([tabindex="-1"]):not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/**
 * Builds the resolver and the dialog that answers it.
 *
 * The resolver's promise is settled by the dialog — or by the request's own signal, so a cancelled
 * call does not leave a person staring at a question about something that already ended.
 */
export function useConfirmationSurface(): ConfirmationSurface {
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const queue = useRef<Pending[]>([]);

  /** Answers the visible prompt and shows the next one, if a second call arrived while it was open. */
  const settle = useCallback((decision: ConfirmationDecision) => {
    setPending((current) => {
      current?.decide(decision);
      return queue.current.shift();
    });
  }, []);

  const resolver = useCallback(
    (request: ConfirmationRequest) =>
      new Promise<ConfirmationDecision>((resolve) => {
        let answered = false;
        const decide = (decision: ConfirmationDecision): void => {
          if (answered) return;
          answered = true;
          resolve(decision);
        };

        // The call ended while this was waiting — cancelled by the agent, or its tool withdrawn by a
        // route change. Refuse rather than leave the promise open: the library will report the
        // cancellation, and the person stops being asked about something that is over.
        request.signal.addEventListener(
          'abort',
          () => {
            decide(CONFIRMATION.refused);
            setPending((current) =>
              current?.request === request ? queue.current.shift() : current,
            );
            queue.current = queue.current.filter((held) => held.request !== request);
          },
          { once: true },
        );

        const entry: Pending = { request, decide };
        setPending((current) => {
          if (current !== undefined) {
            queue.current.push(entry);
            return current;
          }
          return entry;
        });
      }),
    [],
  );

  return {
    resolver,
    dialog: <Dialog pending={pending} settle={settle} />,
    open: pending !== undefined,
  };
}

function Dialog({
  pending,
  settle,
}: {
  pending: Pending | undefined;
  settle: (decision: ConfirmationDecision) => void;
}): ReactNode {
  const panel = useRef<HTMLElement | null>(null);
  /** Where focus was before the prompt appeared, so it can be given back. */
  const restoreTo = useRef<Element | null>(null);

  useEffect(() => {
    if (pending === undefined) {
      // **Closed: focus goes back where the person left it.** Without this, dismissing a dialog drops
      // focus onto `<body>` and the next Tab restarts from the top of the document — a keyboard user
      // loses their place every time an agent asks for something.
      const target = restoreTo.current;
      restoreTo.current = null;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
      return;
    }

    // Set once per run of prompts, not once per prompt: a queued second request must not overwrite
    // the element the FIRST one interrupted.
    restoreTo.current ??= document.activeElement;

    // **Focus the panel, deliberately NOT the approve button.** It used to land on "Yes, do it", so a
    // stray Enter — a keystroke aimed at the page a moment before the prompt appeared — approved an
    // agent-requested mutation. This is the safety boundary of the whole capability model, and the
    // default answer at that boundary must never be yes. The panel itself is neutral: it is focusable
    // only programmatically, and Enter on it does nothing at all.
    panel.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        settle(CONFIRMATION.refused);
        return;
      }
      if (event.key !== 'Tab') return;

      // **The focus trap.** `aria-modal` tells a screen reader the background is unavailable; it does
      // not make Tab stop going there. Without this, tabbing out of the dialog reaches the page it is
      // covering — the person is answering a question while operating the application behind it.
      const inside = panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (inside === undefined || inside.length === 0) return;
      const first = inside[0];
      const last = inside[inside.length - 1];
      if (first === undefined || last === undefined) return;

      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, settle]);

  if (pending === undefined) return null;
  const { request } = pending;

  return (
    <div className="confirm-backdrop" data-testid="confirmation">
      {/* Dismissing is refusing. Never a no-op that leaves the agent waiting, and never an approval.
          Kept out of the tab order: it is a pointer affordance, and a keyboard already has both
          Escape and an explicit No. A full-screen invisible button in the tab cycle would be a
          control a keyboard user cannot see the extent of.
          Labelled rather than `aria-hidden`: hiding a focusable element from assistive technology is
          the contradiction that rule exists to catch, and `tabIndex={-1}` still leaves this one
          focusable by a pointer. Out of the tab order and honestly named is the combination that has
          neither problem. */}
      <button
        type="button"
        className="confirm-dismiss"
        tabIndex={-1}
        aria-label="Refuse and close"
        onClick={() => settle(CONFIRMATION.refused)}
      />
      <section
        className="confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm action"
        ref={panel}
        tabIndex={-1}
      >
        <h2>{request.title ?? request.tool}</h2>
        <p className="muted">{request.description}</p>
        <p className="confirm-tool">
          The agent is asking to run <code>{request.tool}</code>.
        </p>
        {Object.keys(request.arguments).length > 0 && (
          <dl className="confirm-args">
            {Object.entries(request.arguments).map(([field, value]) => (
              <div key={field}>
                <dt>{field}</dt>
                <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="confirm-actions">
          <button type="button" onClick={() => settle(CONFIRMATION.refused)}>
            No
          </button>
          <button type="button" className="primary" onClick={() => settle(CONFIRMATION.approved)}>
            Yes, do it
          </button>
        </div>
      </section>
    </div>
  );
}
