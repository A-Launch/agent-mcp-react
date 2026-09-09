// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  builtSteps,
  CONFIRMATION,
  GATE_CHAIN,
  GATE_STEP_STATE,
  RUNTIME_FAILURE,
} from '../../../src/runtime/index.ts';
import { APPLICATION_ONLY, NOTHING_GRANTED } from '../../support/capabilities.ts';
import { closeAll, stack } from './harness.ts';

// `GATE_CHAIN` checked against what a call actually passes through.
//
// **The neighbouring unit suite reads the constant; this one refuses to.** A table describing itself
// is a comment with a type — it goes stale in exactly the direction that matters, because a step
// deleted in a refactor leaves the entry saying `built` and the repository's own answer to "is that
// checked yet?" becomes a lie a reader has no way to catch. So every claim here is established by
// driving a real call over a real socket and reading the refusal that comes back.
//
// The shape is a PEEL, not a case per step. One tool is made to violate every gate at once and then
// repaired one gate at a time from the top; each repair reveals the next refusal. That asserts the
// ORDER as a consequence rather than as a list of pairs — and, because the walk is compared against
// `builtSteps()` at the end, a step added to the table with no driven case fails here rather than
// quietly widening what the constant claims.

afterEach(closeAll);

interface CallResult {
  isError?: boolean;
  content?: { text?: string }[];
}

function textOf(result: CallResult): string {
  return result.content?.[0]?.text ?? '';
}

/** A tool that records whether the chain ever reached it. */
function recordingTool(): { entered: () => number; handler: () => unknown } {
  let entries = 0;
  return {
    entered: () => entries,
    handler: () => {
      entries += 1;
      return { charged: true };
    },
  };
}

describe('the chain a call actually walks', () => {
  it('refuses at each step in the table’s order, and reaches the handler only when all of them pass', async () => {
    const under = await stack();
    const tool = recordingTool();

    // Every gate is set to refuse before the first call is made. Repairing them one at a time is what
    // makes each answer evidence about ORDER: at every step below, everything downstream is still
    // broken, so a chain that ran in a different order would report a different cause.
    under.grant(NOTHING_GRANTED);
    under.askWith(() => CONFIRMATION.refused);
    await under.registerWithSchemas(
      'billing.charge',
      tool.handler,
      {
        input: {
          type: 'object',
          properties: { amount: { type: 'number' } },
          required: ['amount'],
        },
      },
      { available: false, confirmation: 'required' },
    );

    const walked: { step: string; cause: string }[] = [];
    const call = async (name: string, args: Record<string, unknown>): Promise<string> =>
      textOf((await under.client.callTool({ name, arguments: args })) as CallResult);

    // 2 — resolve. A name nobody registered, on a connection whose capabilities deny everything: if
    // the capability gate ran first this would come back as a denial and tell an agent that a tool
    // which does not exist is one it is not allowed to have.
    walked.push({ step: 'resolve', cause: await call('billing.refund', {}) });

    // 3 — capability. The tool resolves now. Everything after this is still broken.
    walked.push({ step: 'capability', cause: await call('billing.charge', {}) });

    // 4 — policy, which in this build means availability. The capability is granted; the application
    // still is not offering the tool.
    under.grant(APPLICATION_ONLY);
    walked.push({ step: 'policy', cause: await call('billing.charge', {}) });

    // 5 — validate. The tool is offered; the arguments do not match the schema. `confirmation:
    // "required"` is still declared, which is the driven form of "confirmation is step 6, not policy":
    // if it were part of the permission gate, this call would be refused for it instead.
    under.reoffer('billing.charge', { available: true, confirmation: 'required' });
    walked.push({ step: 'validate', cause: await call('billing.charge', {}) });

    // 6 — confirm. The arguments are valid; a person said no.
    walked.push({ step: 'confirm', cause: await call('billing.charge', { amount: 10 }) });

    // Nothing has run. Six refusals, and the application is unchanged — which is the claim the
    // returned causes do NOT make on their own, since a runtime that invoked the handler and reported
    // an error afterwards produces exactly the text above.
    expect(tool.entered()).toBe(0);

    // 7 — invoke.
    under.askWith(() => CONFIRMATION.approved);
    const result = await call('billing.charge', { amount: 10 });
    walked.push({ step: 'invoke', cause: result });
    expect(tool.entered()).toBe(1);
    expect(result).toContain('charged');

    // Each refusal named its own cause, and no other step's.
    const expected: Record<string, string> = {
      resolve: RUNTIME_FAILURE.toolNotFound,
      capability: RUNTIME_FAILURE.capabilityDenied,
      policy: RUNTIME_FAILURE.toolUnavailable,
      validate: RUNTIME_FAILURE.argumentsInvalid,
      confirm: RUNTIME_FAILURE.confirmationRefused,
    };
    for (const { step, cause } of walked) {
      if (step === 'invoke') continue;
      expect(cause).toContain(expected[step]);
      for (const [other, code] of Object.entries(expected)) {
        if (other === step) continue;
        expect(cause).not.toContain(code);
      }
    }

    // **The comparison that keeps the table honest.** A step added to `GATE_CHAIN` as `built` with no
    // driven case fails here — which is the failure mode the constant exists to prevent and cannot
    // catch about itself.
    expect(walked.map((entry) => entry.step)).toEqual(builtSteps().map((step) => step.name));
  });
});

describe('the step this runtime does NOT perform', () => {
  it('serves every call above without authenticating anything, which is why the table says elsewhere', async () => {
    // `authenticate` is `elsewhere`, not `unbuilt` — the distinction is that something else really
    // does it (the gateway, at the socket upgrade), rather than that nobody does. What
    // this case establishes is the half that belongs to the runtime: it is absent from the walk above
    // because the runtime asks nothing about identity, not because the walk skipped a built step.
    const authenticate = GATE_CHAIN.find((step) => step.name === 'authenticate');
    expect(authenticate?.state).toBe(GATE_STEP_STATE.elsewhere);
    expect(builtSteps().map((step) => step.name)).not.toContain('authenticate');

    const under = await stack();
    await under.register('invoice.send', () => 'sent');

    // **The connection really did present an identity**, asserted rather than assumed. The harness has
    // always dialled with a tab id, so the claim below was about an identity-bearing connection only by
    // accident — and a later change that dropped it would have weakened this case without touching it.
    expect(under.connection.tabId).toMatch(/\S/);

    // The runtime was handed no identity, no ticket and no principal, and it served the call. If a
    // future change derived a capability from the connection, the table would have to say so — and
    // this case is where the omission surfaces.
    const result = (await under.client.callTool({
      name: 'invoice.send',
      arguments: {},
    })) as CallResult;
    expect(result.isError).toBeUndefined();

    // And the identity did not become a principal on the way past: the runtime admitted the call on
    // the capabilities the PROVIDER was given, so withdrawing them refuses the same call over the same
    // identity-bearing connection. Presenting an identity is not evidence of anything: a tab id is
    // metadata, never a credential (docs/design.md#page-identity).
    under.grant(NOTHING_GRANTED);
    const refused = (await under.client.callTool({
      name: 'invoice.send',
      arguments: {},
    })) as CallResult;
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });
});
