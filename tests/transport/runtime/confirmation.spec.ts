// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIRMATION, RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { APPLICATION_ONLY, NOTHING_GRANTED } from '../../support/capabilities.ts';
import { closeAll, stack } from './harness.ts';

// Step 6 of the gate chain: a person approving a call before it happens.
//
// **The one thing every case here is really about: the handler must not have been entered.** A gate
// that ran the handler and undid it on refusal would pass a test that only checked the response — and
// it is the tempting design, because it is easier. There is no undo. A handler is an application
// transition; it may have written to a server; and "we did it and then took it back" is not what a
// person approving an action believes they are deciding — the gate runs BEFORE the handler, in the
// runtime, never inside it. So every refusal case here
// records whether the handler was entered, and asserts it was not.
//
// **The second thing, and the one a naive implementation gets wrong: a confirmation takes human time.**
// Minutes, not milliseconds. Everything the first gates checked can change while one is open — the
// operator can withdraw a capability, the application can close the tool, the agent can give up. A
// design that decided all of it up front and then ran the handler on the answer would be approving
// against a page that no longer exists.

afterEach(closeAll);

/** Drains enough turns for a real socket round trip to complete. */
async function settle(turns = 40): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((r) => setImmediate(r));
}

interface CallResult {
  isError?: boolean;
  content?: { text?: string }[];
}

function textOf(result: CallResult): string {
  return result.content?.[0]?.text ?? '';
}

/** A tool that records whether it was entered, so a refusal can be shown never to have reached it. */
function recordingTool(): { entered: () => number; handler: () => unknown } {
  let entries = 0;
  return {
    entered: () => entries,
    handler: () => {
      entries += 1;
      return { done: true };
    },
  };
}

describe('a tool that requires confirmation', () => {
  it('does not run until somebody approves', async () => {
    const under = await stack();
    const tool = recordingTool();
    await under.register('invoice.mark_paid', tool.handler, undefined, {
      confirmation: 'required',
    });
    under.askWith(() => CONFIRMATION.approved);

    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeUndefined();
    expect(tool.entered()).toBe(1);
  });

  it('never enters the handler when the answer is no', async () => {
    // **The assertion this whole file exists for.** Not "the agent got an error" — a gate that ran the
    // handler and reported an error afterwards would satisfy that, and the invoice would be paid.
    const under = await stack();
    const tool = recordingTool();
    await under.register('invoice.mark_paid', tool.handler, undefined, {
      confirmation: 'required',
    });
    under.askWith(() => CONFIRMATION.refused);

    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain(RUNTIME_FAILURE.confirmationRefused);
    expect(tool.entered()).toBe(0);
  });

  it('runs without asking when it does not require confirmation', async () => {
    // The pairing that keeps the gate from being "ask about everything". A resolver that is never
    // consulted for an ordinary tool is what makes `confirmation: 'required'` mean something.
    const under = await stack();
    const tool = recordingTool();
    let asked = 0;
    await under.register('invoice.send', tool.handler);
    under.askWith(() => {
      asked += 1;
      return CONFIRMATION.refused;
    });

    const result = (await under.client.callTool({
      name: 'invoice.send',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeUndefined();
    expect(asked).toBe(0);
    expect(tool.entered()).toBe(1);
  });
});

describe('a deployment with nobody to ask', () => {
  it('refuses the call, with its own cause', async () => {
    const under = await stack();
    const tool = recordingTool();
    await under.register('invoice.mark_paid', tool.handler, undefined, {
      confirmation: 'required',
    });
    under.askWith(undefined);

    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain(RUNTIME_FAILURE.confirmationUnavailable);
    expect(tool.entered()).toBe(0);
  });

  it('leaves the tool listed', async () => {
    // What is true is "it cannot be approved here", not "it does not exist" — and an operator
    // reading a refusal fixes it by supplying a resolver, which they will not do if the tool has
    // silently vanished from every listing on the page.
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid', undefined, {
      confirmation: 'required',
    });
    under.askWith(undefined);
    await settle();

    const listed = (await under.client.listTools()) as { tools: { name: string }[] };
    expect(listed.tools.map((tool) => tool.name)).toContain('invoice.mark_paid');
  });

  it('runs the same tool once a resolver is supplied', async () => {
    // The pairing, and the reason the absence is a deployment fact rather than a property of the tool.
    const under = await stack();
    const tool = recordingTool();
    await under.register('invoice.mark_paid', tool.handler, undefined, {
      confirmation: 'required',
    });
    under.askWith(undefined);

    expect(
      textOf(
        (await under.client.callTool({ name: 'invoice.mark_paid', arguments: {} })) as CallResult,
      ),
    ).toContain(RUNTIME_FAILURE.confirmationUnavailable);

    under.askWith(() => CONFIRMATION.approved);
    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeUndefined();
    expect(tool.entered()).toBe(1);
  });
});

describe('what the resolver is shown', () => {
  it('gets the tool by name and by title, and the validated arguments', async () => {
    const under = await stack();
    let seen: { tool: string | undefined; title: string | undefined; args: unknown } = {
      tool: undefined,
      title: undefined,
      args: undefined,
    };
    await under.registerWithSchemas(
      'billing.charge',
      () => 'charged',
      { input: { type: 'object', properties: { amount: { type: 'number' } } } },
      { confirmation: 'required' },
    );
    under.askWith((request) => {
      seen = { tool: request.tool, title: request.title, args: request.arguments };
      return CONFIRMATION.approved;
    });

    await under.client.callTool({ name: 'billing.charge', arguments: { amount: 40 } });

    expect(seen.tool).toBe('billing.charge');
    expect(seen.args).toEqual({ amount: 40 });
  });

  it('gets a snapshot it cannot change, all the way down', async () => {
    // **A shallow freeze passes the top-level half of this and fails the nested one**, which is why the
    // case is nested. The failure it prevents: a person is shown `{ transfer: { amount: 10 } }`,
    // approves it, and something rewrites the amount before the handler runs.
    const under = await stack();
    let received: unknown;
    let topLevelAfterAttempt: unknown;
    let nestedAfterAttempt: unknown;

    await under.register(
      'bank.transfer',
      (args) => {
        received = args;
        return 'sent';
      },
      undefined,
      { confirmation: 'required' },
    );

    under.askWith((request) => {
      const shown = request.arguments as { note?: string; transfer?: { amount?: number } };
      try {
        (shown as { note?: string }).note = 'tampered';
      } catch {
        // Frozen, which is the point. Swallowed so the resolver still returns a decision and the case
        // can go on to assert what the handler received.
      }
      try {
        (shown.transfer as { amount?: number }).amount = 99_999;
      } catch {
        // The nested half — the one a shallow freeze leaves writable.
      }
      topLevelAfterAttempt = shown.note;
      nestedAfterAttempt = shown.transfer?.amount;
      return CONFIRMATION.approved;
    });

    await under.client.callTool({
      name: 'bank.transfer',
      arguments: { note: 'rent', transfer: { amount: 10 } },
    });

    expect(topLevelAfterAttempt).toBe('rent');
    expect(nestedAfterAttempt).toBe(10);
    // And detachment, which is a different protection from immutability: whatever the resolver did to
    // what it was shown could not have reached the handler anyway.
    expect(received).toEqual({ note: 'rent', transfer: { amount: 10 } });
  });

  it('gets a signal that aborts when the agent gives up', async () => {
    // A dialog left open for a call nobody is waiting for is a dialog that gets approved by mistake
    // later. The runtime does not need the resolver to cooperate — the await is raced — but a surface
    // that cannot close itself is a surface that misleads a person.
    const under = await stack();
    let sawSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    await under.register('invoice.mark_paid', () => 'paid', undefined, {
      confirmation: 'required',
    });
    under.askWith(async (request) => {
      sawSignal = request.signal;
      await blocked;
      return CONFIRMATION.approved;
    });

    const cancel = new AbortController();
    const call = under.client
      .callTool({ name: 'invoice.mark_paid', arguments: {} }, { signal: cancel.signal })
      .catch(() => 'rejected');

    await settle();
    expect(sawSignal?.aborted).toBe(false);

    cancel.abort(new Error('changed its mind'));
    await settle();

    expect(sawSignal?.aborted).toBe(true);
    release?.();
    await call;
  });
});

describe('everything that is not an approval', () => {
  it.each([
    ['refused outright', () => CONFIRMATION.refused],
    [
      'threw synchronously',
      () => {
        throw new Error('hunter2-secret');
      },
    ],
    ['rejected', () => Promise.reject(new Error('hunter2-secret'))],
    ['returned nothing, the way a dismissed dialog does', () => undefined],
    ['returned true, the way an author who assumed a boolean would', () => true],
    ['returned a string that is not a decision', () => 'yes'],
    ['returned a decision-shaped object rather than a decision', () => ({ approved: true })],
  ])('denies when the resolver %s', async (_label, resolver) => {
    // **One outcome, deliberately, and the truthiness cases are the reason.** A gate that asked "is it
    // truthy" would read `true` and `'yes'` and `{approved: true}` as consent — each of them written by
    // an author who believed they were approving, and none of them a decision.
    const under = await stack();
    const tool = recordingTool();
    await under.register('invoice.mark_paid', tool.handler, undefined, {
      confirmation: 'required',
    });
    under.askWith(resolver as never);

    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain(RUNTIME_FAILURE.confirmationRefused);
    expect(tool.entered()).toBe(0);
  });

  it('never carries what the resolver produced back to the agent', async () => {
    // A resolver's error message is application text and this is a socket. The agent also has no
    // business learning about the inside of a dialog — and a model told "your approval attempt
    // crashed" would reasonably retry, where it must not retry a refusal.
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid', undefined, {
      confirmation: 'required',
    });
    under.askWith(() => {
      throw new Error('hunter2-secret from inside the dialog');
    });

    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).not.toContain('hunter2-secret');
    expect(textOf(result)).not.toContain('dialog');
  });

  it('tells a declined call apart from one nobody could approve', async () => {
    // Two different things for an operator: a person said no, versus this deployment has no way to
    // ask. Merging them would send somebody to configure a resolver that is already there.
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid', undefined, {
      confirmation: 'required',
    });

    under.askWith(() => CONFIRMATION.refused);
    const declined = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    under.askWith(undefined);
    const unaskable = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(textOf(declined)).toContain(RUNTIME_FAILURE.confirmationRefused);
    expect(textOf(declined)).not.toContain(RUNTIME_FAILURE.confirmationUnavailable);
    expect(textOf(unaskable)).toContain(RUNTIME_FAILURE.confirmationUnavailable);
  });
});

describe('the world changing while a confirmation is open', () => {
  /** A resolver that parks until the case releases it, so a case can act while the prompt is open. */
  function pausing(): {
    opened: Promise<void>;
    answer: (decision: (typeof CONFIRMATION)[keyof typeof CONFIRMATION]) => void;
    resolver: () => Promise<(typeof CONFIRMATION)[keyof typeof CONFIRMATION]>;
  } {
    let announce: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let give: ((decision: (typeof CONFIRMATION)[keyof typeof CONFIRMATION]) => void) | undefined;
    const answered = new Promise<(typeof CONFIRMATION)[keyof typeof CONFIRMATION]>((resolve) => {
      give = resolve;
    });
    return {
      opened,
      answer: (decision) => give?.(decision),
      resolver: () => {
        announce?.();
        return answered;
      },
    };
  }

  it('refuses an approved call whose capability was withdrawn while the prompt was open', async () => {
    // The reason the recheck reads live values. A confirmation is human-scale: an
    // operator can revoke a capability in the minutes a dialog is on screen, and running the handler
    // on the strength of an answer given before that would be widening authority after the fact.
    const under = await stack();
    const tool = recordingTool();
    await under.register('invoice.mark_paid', tool.handler, undefined, {
      confirmation: 'required',
    });
    const prompt = pausing();
    under.askWith(prompt.resolver);

    const call = under.client.callTool({ name: 'invoice.mark_paid', arguments: {} });
    await prompt.opened;

    under.grant(NOTHING_GRANTED);
    prompt.answer(CONFIRMATION.approved);

    const result = (await call) as CallResult;
    expect(textOf(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
    expect(tool.entered()).toBe(0);
  });

  it('refuses an approved call whose tool the application closed while the prompt was open', async () => {
    const under = await stack();
    const tool = recordingTool();
    await under.register('invoice.mark_paid', tool.handler, undefined, {
      confirmation: 'required',
    });
    const prompt = pausing();
    under.askWith(prompt.resolver);

    const call = under.client.callTool({ name: 'invoice.mark_paid', arguments: {} });
    await prompt.opened;

    under.reoffer('invoice.mark_paid', { confirmation: 'required', available: false });
    prompt.answer(CONFIRMATION.approved);

    const result = (await call) as CallResult;
    expect(textOf(result)).toContain(RUNTIME_FAILURE.toolUnavailable);
    expect(tool.entered()).toBe(0);
  });

  it('runs when nothing changed, which is what makes the two above mean anything', async () => {
    // The pairing. A recheck that refused every approval would satisfy both cases above and would make
    // `confirmation: 'required'` mean "never".
    const under = await stack();
    const tool = recordingTool();
    await under.register('invoice.mark_paid', tool.handler, undefined, {
      confirmation: 'required',
    });
    const prompt = pausing();
    under.askWith(prompt.resolver);

    const call = under.client.callTool({ name: 'invoice.mark_paid', arguments: {} });
    await prompt.opened;
    prompt.answer(CONFIRMATION.approved);

    const result = (await call) as CallResult;
    expect(result.isError).toBeUndefined();
    expect(tool.entered()).toBe(1);
  });

  it('reports the cancellation when it latches between the answer and the continuation', async () => {
    // **The interleaving that only the re-read after the await catches.** The other
    // withdrawal case below is caught by `bounded()` — the cancellation lands while the resolver is
    // still parked, so the race sees it. Here the resolver ANSWERS first and the cancellation latches
    // in the same synchronous stack: the race resolves with the decision, and without the re-read the
    // handler starts for a call nobody is waiting for.
    //
    // Measured: deleting the re-read leaves every other case in this file green. Only this one goes red.
    const under = await stack();
    const tool = recordingTool();
    const withdraw = await under.register('invoice.mark_paid', tool.handler, undefined, {
      confirmation: 'required',
    });

    under.askWith(() => {
      // The tool stops being declared, and the decision is given, in one stack. The decision wins the
      // race because its promise was handed to `Promise.race` first.
      withdraw();
      return CONFIRMATION.approved;
    });

    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain(RUNTIME_FAILURE.callAbandoned);
    expect(tool.entered()).toBe(0);
  });

  it('reports the cancellation, not a permission denial, when the tool is withdrawn under it', async () => {
    // An agent told "permission denied" for a call that was actually abandoned goes looking
    // for a capability problem that does not exist — and a route change is not a permission decision.
    const under = await stack();
    const tool = recordingTool();
    const withdraw = await under.register('invoice.mark_paid', tool.handler, undefined, {
      confirmation: 'required',
    });
    const prompt = pausing();
    under.askWith(prompt.resolver);

    const call = under.client.callTool({ name: 'invoice.mark_paid', arguments: {} });
    await prompt.opened;

    withdraw();
    await settle();

    const result = (await call) as CallResult;
    expect(textOf(result)).toContain(RUNTIME_FAILURE.callAbandoned);
    expect(textOf(result)).not.toContain(RUNTIME_FAILURE.confirmationRefused);
    expect(tool.entered()).toBe(0);

    prompt.answer(CONFIRMATION.approved);
  });
});

describe('where the confirmation gate sits among the others', () => {
  it('refuses invalid arguments before anybody is asked', async () => {
    // Nobody should be shown a dialog about a call that was never going to run. A person asked to
    // approve arguments the runtime has already rejected is being asked to approve nothing.
    const under = await stack();
    let asked = 0;
    await under.registerWithSchemas(
      'billing.charge',
      () => 'charged',
      {
        input: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
      },
      { confirmation: 'required' },
    );
    under.askWith(() => {
      asked += 1;
      return CONFIRMATION.approved;
    });

    const result = (await under.client.callTool({
      name: 'billing.charge',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain(RUNTIME_FAILURE.argumentsInvalid);
    expect(asked).toBe(0);
  });

  it('refuses on the capability before anybody is asked', async () => {
    const under = await stack();
    let asked = 0;
    await under.register('invoice.mark_paid', () => 'paid', undefined, {
      confirmation: 'required',
    });
    under.askWith(() => {
      asked += 1;
      return CONFIRMATION.approved;
    });
    under.grant(NOTHING_GRANTED);

    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
    expect(asked).toBe(0);
  });

  it('asks once the earlier gates have passed', async () => {
    // The pairing for the two orderings above.
    const under = await stack();
    let asked = 0;
    await under.registerWithSchemas(
      'billing.charge',
      () => 'charged',
      {
        input: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
      },
      { confirmation: 'required' },
    );
    under.askWith(() => {
      asked += 1;
      return CONFIRMATION.approved;
    });
    under.grant(APPLICATION_ONLY);

    const result = (await under.client.callTool({
      name: 'billing.charge',
      arguments: { amount: 40 },
    })) as CallResult;

    expect(result.isError).toBeUndefined();
    expect(asked).toBe(1);
  });
});
