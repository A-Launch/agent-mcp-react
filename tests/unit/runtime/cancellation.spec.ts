import { describe, expect, it } from 'vitest';
import { CONTROL_LEVEL } from '../../../src/index.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/errors.ts';
import {
  type InvocationInputs,
  type InvocationTarget,
  invoke,
  type ToolCallResult,
} from '../../../src/runtime/invocation.ts';
import type { ToolHandler } from '../../../src/runtime/ownership.ts';
import { VALIDATION } from '../../../src/runtime/validation.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';

// A cancelled call never reports success (`docs/design.md#cancellation`), and the classification is
// read from the SIGNAL rather than from anything the handler threw.
//
// **Why almost every case here needs a pairing.** The guarantees in this file are negatives — no
// success, no handler entry, no execution-failure verdict — and a runtime that reported every call as
// cancelled would satisfy each of them alone. So every case that asserts a call did NOT succeed sits
// next to one on the same setup where it must, and every case that asserts a cancellation verdict sits
// next to one asserting the same shape of failure is still an execution failure when nothing aborted.
//
// The interesting half is the handler that IGNORES the signal. Respecting cancellation is something
// a handler SHOULD do; the guarantee that a cancelled call is never reported as a success may
// not depend on it, because a handler that ignores it is the common case rather than the exotic one.

/** The inputs one invocation needs: a request signal a case can abort, and a barrier it can control. */
function callWith(
  requestSignal: AbortSignal,
  afterRender: () => Promise<void> = () => Promise.resolve(),
): InvocationInputs {
  return {
    requestSignal,
    afterRender,
    capabilities: () => APPLICATION_ONLY,
    level: CONTROL_LEVEL.application,
    permissions: () => undefined,
  };
}

/**
 * The tool, as an invocation sees it.
 *
 * An `InvocationTarget` rather than an `InvocationTarget`: what a call needs to know is the handler, its
 * declaration lifetime, its compiled schemas and what a person would be shown — never which table it
 * came from. A built-in satisfies the same shape.
 */
function entryFor(handler: ToolHandler, lifetime?: AbortSignal): InvocationTarget {
  return {
    handler,
    description: 'sets',
    ...(lifetime === undefined ? {} : { lifetime }),
  };
}

/** The code a result carries, read from the text this library composed rather than guessed at. */
function codeOf(result: ToolCallResult): string {
  return (result.content[0]?.text ?? '').split(':')[0] ?? '';
}

describe('a call whose signal aborted before the handler was entered', () => {
  it('does not enter the handler, and reports a cancellation', async () => {
    let entered = false;
    const controller = new AbortController();
    controller.abort();

    const result = await invoke(
      'panel.set',
      entryFor(() => {
        entered = true;
        return 'ok';
      }),
      {},
      callWith(controller.signal),
    );

    // The recorder, not the returned error. Asserting only the error would pass for a handler that
    // ran, mutated the application, and then had its result thrown away — which is the outcome this
    // check exists to prevent, since the mutation is the part that cannot be undone.
    expect(entered).toBe(false);
    expect(result.isError).toBe(true);
    expect(codeOf(result)).toBe(RUNTIME_FAILURE.callCancelled);
  });

  it('enters the handler and succeeds when nothing aborted', async () => {
    let entered = false;
    const result = await invoke(
      'panel.set',
      entryFor(() => {
        entered = true;
        return 'ok';
      }),
      {},
      callWith(new AbortController().signal),
    );

    // The pairing. A runtime that never entered any handler would pass the case above.
    expect(entered).toBe(true);
    expect(result.isError).toBeUndefined();
  });
});

describe('a cancelled call whose arguments are also wrong', () => {
  it('is reported as cancelled, not as a validation failure', async () => {
    // Nothing ran, so there is nothing for an agent to correct — and in the withdrawal case it is
    // still waiting, so telling it to fix its arguments would send it back to a tool that no longer
    // exists.
    const lifetime = new AbortController();
    lifetime.abort();
    const entry = {
      ...entryFor(() => 'ok', lifetime.signal),
      validators: {
        input: { validate: async () => ({ verdict: VALIDATION.invalid, reason: 'nope' }) },
      },
    } as unknown as InvocationTarget;

    const result = await invoke('panel.set', entry, {}, callWith(new AbortController().signal));

    expect(codeOf(result)).toBe(RUNTIME_FAILURE.callAbandoned);
  });

  it('is reported as a validation failure when nothing cancelled it', async () => {
    // The pairing. Reporting every refusal as a cancellation would pass the case above and would hide
    // every genuine schema violation behind it.
    const entry = {
      ...entryFor(() => 'ok'),
      validators: {
        input: { validate: async () => ({ verdict: VALIDATION.invalid, reason: 'nope' }) },
      },
    } as unknown as InvocationTarget;

    const result = await invoke('panel.set', entry, {}, callWith(new AbortController().signal));

    expect(codeOf(result)).toBe(RUNTIME_FAILURE.argumentsInvalid);
  });
});

describe('a handler that ignores the signal completely', () => {
  it('still does not produce a success when the call was cancelled while it ran', async () => {
    const controller = new AbortController();
    const result = await invoke(
      'panel.set',
      entryFor(async () => {
        // Exactly what an application that never reads `context.signal` does: it keeps working.
        controller.abort();
        await Promise.resolve();
        return { done: true };
      }),
      {},
      callWith(controller.signal),
    );

    expect(result.isError).toBe(true);
    expect(codeOf(result)).toBe(RUNTIME_FAILURE.callCancelled);
    // And what it returned is nowhere in what the agent receives. A result that leaked through
    // alongside the error would be read as a success by anything that looks at content first.
    expect(JSON.stringify(result)).not.toContain('done');
  });

  it('produces that same value as a success when nothing cancelled the call', async () => {
    const result = await invoke(
      'panel.set',
      entryFor(async () => {
        await Promise.resolve();
        return { done: true };
      }),
      {},
      callWith(new AbortController().signal),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('done');
  });
});

describe('a handler that throws', () => {
  it('is a cancellation when the signal aborted', async () => {
    const controller = new AbortController();
    const result = await invoke(
      'panel.set',
      entryFor(async () => {
        controller.abort();
        // The shape an aborted `fetch` produces. Deliberately a plain error rather than a DOMException
        // named AbortError, because the verdict must not come from the thrown value at all.
        throw new Error('the request was aborted');
      }),
      {},
      callWith(controller.signal),
    );

    expect(codeOf(result)).toBe(RUNTIME_FAILURE.callCancelled);
  });

  it('is still an execution failure when nothing aborted, even if it looks like an abort', async () => {
    // The pairing, and the one that catches classification by the error's name. An application is
    // entitled to construct an `AbortError` for its own reasons, and reporting that as a cancellation
    // would tell an agent it caused something it did not.
    const looksLikeAnAbort = new Error('The operation was aborted.');
    looksLikeAnAbort.name = 'AbortError';

    const result = await invoke(
      'panel.set',
      entryFor(() => {
        throw looksLikeAnAbort;
      }),
      {},
      callWith(new AbortController().signal),
    );

    expect(codeOf(result)).toBe(RUNTIME_FAILURE.toolExecutionFailed);
  });
});

describe('which cancellation it was', () => {
  it('is abandonment when the tool stopped being declared', async () => {
    const lifetime = new AbortController();

    const result = await invoke(
      'panel.set',
      entryFor(async () => {
        lifetime.abort();
        await Promise.resolve();
        return 'ok';
      }, lifetime.signal),
      {},
      // Only the REQUEST signal is handed in. The runtime composes it with the entry's declaration
      // lifetime itself, which is the arrangement a real call has.
      callWith(new AbortController().signal),
    );

    // Its own code, because the diagnosis is the opposite one: the agent is still waiting, so this
    // result is a frame that genuinely gets sent, and an operator reading it is looking at a route
    // change racing a tool call rather than at nothing wrong.
    expect(codeOf(result)).toBe(RUNTIME_FAILURE.callAbandoned);
  });

  it('is plain cancellation when the tool is still declared', async () => {
    // The pairing. Reporting everything as abandonment would pass the case above and would tell an
    // operator a component unmounted every time an agent changed its mind.
    const lifetime = new AbortController();
    const request = new AbortController();

    const result = await invoke(
      'panel.set',
      entryFor(async () => {
        request.abort();
        await Promise.resolve();
        return 'ok';
      }, lifetime.signal),
      {},
      callWith(request.signal),
    );

    expect(codeOf(result)).toBe(RUNTIME_FAILURE.callCancelled);
  });
});

describe('a handler waiting on the render barrier', () => {
  it('is thrown out of the wait, rather than left in it', async () => {
    // **What the context-level barrier race actually does, asserted where only it can be seen.**
    //
    // The outer machinery would report a cancellation for this call either way — the handler is raced
    // — so a case that only checked the returned code would stay green with the barrier race deleted
    // and the handler still sitting inside `await context.afterRender()` forever. What is asserted
    // here is the handler's own experience: it resumes, by throwing, at the line that asked to wait.
    const controller = new AbortController();
    let unwound = false;

    await invoke(
      'panel.set',
      entryFor(async (_input, context) => {
        queueMicrotask(() => controller.abort());
        try {
          await context.afterRender();
        } catch {
          unwound = true;
        }
        // Deliberately keeps running afterwards, the way an uncooperative handler would. The call's
        // outcome is settled by then; what this case is about is that the handler was not abandoned
        // inside a promise nothing will settle.
        return 'applied';
      }),
      {},
      callWith(controller.signal, () => new Promise<void>(() => undefined)),
    );

    expect(unwound).toBe(true);
  });

  it('is not thrown out when the barrier settles normally', async () => {
    // The pairing. A barrier that rejected unconditionally would pass the case above and would break
    // every handler that waits for a render.
    let unwound = false;

    await invoke(
      'panel.set',
      entryFor(async (_input, context) => {
        try {
          await context.afterRender();
        } catch {
          unwound = true;
        }
        return 'applied';
      }),
      {},
      callWith(new AbortController().signal),
    );

    expect(unwound).toBe(false);
  });

  it('does not report success when the call is cancelled while it waits', async () => {
    const controller = new AbortController();
    // A barrier that never resolves on its own — the page has gone quiet. Without the runtime's race
    // this handler waits forever and the call never settles for the agent at all.
    const result = await invoke(
      'panel.set',
      entryFor(async (_input, context) => {
        queueMicrotask(() => controller.abort());
        await context.afterRender();
        return 'applied';
      }),
      {},
      callWith(controller.signal, () => new Promise<void>(() => undefined)),
    );

    expect(result.isError).toBe(true);
    expect(codeOf(result)).toBe(RUNTIME_FAILURE.callCancelled);
  });

  it('resolves and succeeds when the barrier settles and nothing cancelled', async () => {
    const result = await invoke(
      'panel.set',
      entryFor(async (_input, context) => {
        await context.afterRender();
        return 'applied';
      }),
      {},
      callWith(new AbortController().signal),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('applied');
  });
});

describe('a handler that never returns at all', () => {
  it('still settles the call when the tool is withdrawn under it', async () => {
    // **The case checkpoint-only cancellation cannot pass, and the reason the handler is raced.**
    //
    // The handler awaits something that never settles and never looks at its signal. Control never
    // comes back to this library, so no amount of checking at resumption points helps: there is no
    // resumption. The agent did not cancel — it is still waiting — so a frame is still owed, and
    // without one the request hangs until the client's own timeout with nothing to diagnose.
    const lifetime = new AbortController();
    let released = false;

    const call = invoke(
      'panel.set',
      entryFor(async () => {
        await new Promise<void>(() => undefined);
        released = true;
        return 'ok';
      }, lifetime.signal),
      {},
      callWith(new AbortController().signal),
    );

    lifetime.abort();
    const result = await Promise.race([
      call,
      new Promise<'never settled'>((resolve) => {
        setTimeout(() => resolve('never settled'), 500);
      }),
    ]);

    expect(result).not.toBe('never settled');
    expect(codeOf(result as ToolCallResult)).toBe(RUNTIME_FAILURE.callAbandoned);
    // And the trade this makes, asserted so it is not discovered later as a surprise: the handler is
    // still suspended. This library cannot kill a running function, and an outcome that arrives while
    // uncooperative work is in flight beats no outcome at all.
    expect(released).toBe(false);
  });

  it('does not settle on its own when nothing cancels it', async () => {
    // The pairing. A runtime that settled every call after a turn would pass the case above and would
    // cut every slow handler short.
    const settled = await Promise.race([
      invoke(
        'panel.set',
        entryFor(async () => {
          await new Promise<void>(() => undefined);
          return 'ok';
        }),
        {},
        callWith(new AbortController().signal),
      ),
      new Promise<'still running'>((resolve) => {
        setTimeout(() => resolve('still running'), 200);
      }),
    ]);

    expect(settled).toBe('still running');
  });
});

describe('when both sources abort, the FIRST one is the verdict', () => {
  it('reports the agent when the agent cancelled first and the component unmounted after', async () => {
    // Reading a signal's `aborted` afterwards answers "did this ever happen?" rather than "what ended
    // the call?". Both are aborted by the end of this case, and reporting the unmount would send an
    // operator looking for a route change that had nothing to do with it.
    const lifetime = new AbortController();
    const request = new AbortController();

    const result = await invoke(
      'panel.set',
      entryFor(async () => {
        request.abort();
        lifetime.abort();
        await new Promise<void>(() => undefined);
        return 'ok';
      }, lifetime.signal),
      {},
      callWith(request.signal),
    );

    expect(codeOf(result)).toBe(RUNTIME_FAILURE.callCancelled);
  });

  it('reports the withdrawal when the component unmounted first', async () => {
    // The pairing, and the same two aborts in the other order. A rule that always preferred one source
    // would pass exactly one of this pair.
    const lifetime = new AbortController();
    const request = new AbortController();

    const result = await invoke(
      'panel.set',
      entryFor(async () => {
        lifetime.abort();
        request.abort();
        await new Promise<void>(() => undefined);
        return 'ok';
      }, lifetime.signal),
      {},
      callWith(request.signal),
    );

    expect(codeOf(result)).toBe(RUNTIME_FAILURE.callAbandoned);
  });
});

describe('a cancellation that lands after the handler already ran', () => {
  it('says so, rather than telling the agent nothing happened', async () => {
    // **Never reporting a false refusal, reconciled with the requirement that every call settles.**
    //
    // Post-handler work — proving the result can cross a wire, checking it against a declared output
    // schema — is asynchronous, and a validator is application-adjacent code that can take arbitrarily
    // long or never finish. Bounding it is why an outcome always arrives. But the handler HAS run and
    // the application may already have changed, so an outcome that merely said "cancelled" would tell
    // the agent nothing happened and invite it to perform the mutation twice.
    //
    // The history goes in the message rather than into a third code: it is the same two causes with
    // different pasts, and a closed set has to stay small enough to reason about.
    const controller = new AbortController();
    const entry = {
      ...entryFor(() => ({ n: 1 })),
      validators: {
        output: {
          validate: async () => {
            controller.abort();
            // Never settles, which is the case that would otherwise hang: the handler is done, the
            // agent is waiting, and nothing more is coming.
            await new Promise<void>(() => undefined);
            return { verdict: VALIDATION.valid };
          },
        },
      },
    } as unknown as InvocationTarget;

    const settled = await Promise.race([
      invoke('panel.set', entry, {}, callWith(controller.signal)),
      new Promise<'never settled'>((resolve) => {
        setTimeout(() => resolve('never settled'), 500);
      }),
    ]);

    expect(settled).not.toBe('never settled');
    const result = settled as ToolCallResult;
    expect(codeOf(result)).toBe(RUNTIME_FAILURE.callCancelled);
    expect(result.content[0]?.text).toContain('had already run');
  });

  it('does not say so when nothing had run yet', async () => {
    // The pairing. A message that always claimed the tool had run would make every cancellation look
    // like a half-applied mutation, and an agent would stop retrying calls it should retry.
    const controller = new AbortController();
    controller.abort();

    const result = await invoke(
      'panel.set',
      entryFor(() => 'ok'),
      {},
      callWith(controller.signal),
    );

    expect(result.content[0]?.text).not.toContain('had already run');
  });

  it('reports the result when the handler finished before the abort was latched', async () => {
    // **The window a boolean cannot see.** The handler completes; an abort is queued behind it as a
    // microtask. By the time the verdict is read the signal IS aborted — so `signal.aborted` reports a
    // cancellation for a call that finished first. Comparing stamps on one clock is what makes this
    // resolve correctly, and it is the case that reproduces the defect: a handler that finished first
    // reported as cancelled.
    const controller = new AbortController();
    const result = await invoke(
      'panel.set',
      entryFor(() => {
        // Queued AFTER the handler's own completion stamp, which is attached to its returned promise.
        queueMicrotask(() => queueMicrotask(() => controller.abort()));
        return 'applied';
      }),
      {},
      callWith(controller.signal),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('applied');
  });

  it('reports the cancellation when it lands before the handler completes', async () => {
    // The pairing, one ordering apart. Preferring completion whenever a handler eventually finished
    // would pass the case above and would report a stale success for every cancelled call.
    const controller = new AbortController();
    const result = await invoke(
      'panel.set',
      entryFor(async () => {
        controller.abort();
        await Promise.resolve();
        return 'applied';
      }),
      {},
      callWith(controller.signal),
    );

    expect(codeOf(result)).toBe(RUNTIME_FAILURE.callCancelled);
  });
});

describe('a validator that never settles', () => {
  it('does not hang the call when the tool is withdrawn under it', async () => {
    // Cancellation bounds the whole invocation, not only the handler. A validator is
    // application-adjacent code exactly as a handler is — the embedder supplies it — so one that never
    // settles hangs a call in the same way, and the agent has no more to diagnose in one case than the
    // other.
    const lifetime = new AbortController();
    const entry = {
      ...entryFor(() => 'ok', lifetime.signal),
      validators: {
        input: { validate: () => new Promise<never>(() => undefined) },
      },
    } as unknown as InvocationTarget;

    const call = invoke('panel.set', entry, {}, callWith(new AbortController().signal));
    lifetime.abort();

    const settled = await Promise.race([
      call,
      new Promise<'never settled'>((resolve) => {
        setTimeout(() => resolve('never settled'), 500);
      }),
    ]);

    expect(settled).not.toBe('never settled');
    expect(codeOf(settled as ToolCallResult)).toBe(RUNTIME_FAILURE.callAbandoned);
    // Nothing ran, so the message must not claim otherwise.
    expect((settled as ToolCallResult).content[0]?.text).not.toContain('had already run');
  });

  it('still hangs nothing and refuses nothing when the call is not cancelled', async () => {
    // The pairing. An invocation that gave up on slow validation by itself would pass the case above
    // and would refuse every call whose validator took a moment.
    const entry = {
      ...entryFor(() => 'ok'),
      validators: {
        input: { validate: () => new Promise<never>(() => undefined) },
      },
    } as unknown as InvocationTarget;

    const settled = await Promise.race([
      invoke('panel.set', entry, {}, callWith(new AbortController().signal)),
      new Promise<'still running'>((resolve) => {
        setTimeout(() => resolve('still running'), 200);
      }),
    ]);

    expect(settled).toBe('still running');
  });
});

describe('every path settles', () => {
  // The unit half of "every call produces an outcome". The failure this guards against is a call that
  // ends nowhere — no result, no
  // throw — which is invisible from inside a handler and shows up as an agent blocking until its own
  // timeout. It has bitten this project once already, through a result that could not be serialized.
  const arrangements: ReadonlyArray<[string, () => Promise<ToolCallResult>]> = [
    [
      'aborted before entry',
      () => {
        const controller = new AbortController();
        controller.abort();
        return invoke(
          'panel.set',
          entryFor(() => 'ok'),
          {},
          callWith(controller.signal),
        );
      },
    ],
    [
      'aborted while the handler ran',
      () => {
        const controller = new AbortController();
        return invoke(
          'panel.set',
          entryFor(async () => {
            controller.abort();
            await Promise.resolve();
            return 'ok';
          }),
          {},
          callWith(controller.signal),
        );
      },
    ],
    [
      'aborted while the handler waited on the barrier',
      () => {
        const controller = new AbortController();
        return invoke(
          'panel.set',
          entryFor(async (_input, context) => {
            queueMicrotask(() => controller.abort());
            await context.afterRender();
            return 'ok';
          }),
          {},
          callWith(controller.signal, () => new Promise<void>(() => undefined)),
        );
      },
    ],
    [
      'aborted after the handler already returned',
      async () => {
        const controller = new AbortController();
        const result = await invoke(
          'panel.set',
          entryFor(() => 'ok'),
          {},
          callWith(controller.signal),
        );
        controller.abort();
        return result;
      },
    ],
  ];

  for (const [what, run] of arrangements) {
    it(`produces a result: ${what}`, async () => {
      const settled = await Promise.race([
        run(),
        new Promise<'never settled'>((resolve) => {
          setTimeout(() => resolve('never settled'), 500);
        }),
      ]);
      expect(settled).not.toBe('never settled');
      expect((settled as ToolCallResult).content).toBeDefined();
    });
  }

  it('reports the mutation, not a cancellation, when the abort landed after the handler returned', async () => {
    // A completed call is never reported as cancelled, and this is the mirror image of everything else in this file. The handler ran and the
    // application may already have changed; telling the agent the call was cancelled would say nothing
    // happened, which is false, and would invite it to perform the mutation a second time.
    const controller = new AbortController();
    const result = await invoke(
      'panel.set',
      entryFor(() => 'applied'),
      {},
      callWith(controller.signal),
    );
    controller.abort();

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('applied');
  });
});
