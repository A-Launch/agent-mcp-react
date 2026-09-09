import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, REACT_REFUSED, useMcpState } from '../../src/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  clearRegistry,
  enterSecureContext,
  neverConnects,
  registeredNames,
  testValidator,
  until,
} from './harness.ts';

// A state read is a tool call, and every gate that governs a mutating tool governs it.
//
// **This file exists because a read SOUNDS harmless**, and that is how a gate chain acquires its first
// exception with a rationale attached. Nothing here is new behaviour — it is all inherited — which is
// precisely why it needs asserting: inherited behaviour is what gets quietly exempted, and a
// composition that stopped being a composition would fail here and nowhere else.
//
// Every case asserts the refusal at INVOCATION rather than absence from a listing. An agent may hold
// a list from before a withdrawal, and a well-behaved client is not the case a control exists for.

const SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' }, secret: { type: 'string' } },
  required: ['query'],
} as const;

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
});

afterEach(clearRegistry);

/** Calls through the registry, returning the envelope rather than throwing on refusal. */
async function callRegistry(name: string): Promise<{ ok: boolean; text: string; value?: unknown }> {
  const registry = (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  if (registry === undefined) throw new Error('the document has no registry');
  const invoke = (registry as { executeToolByName(...a: unknown[]): Promise<unknown> })
    .executeToolByName;
  try {
    const result = await invoke.call(registry, name, JSON.stringify({}), undefined, true);
    const shaped = (typeof result === 'string' ? JSON.parse(result) : result) as {
      isError?: boolean;
      content?: { text?: string }[];
      structuredContent?: unknown;
    };
    return {
      ok: shaped.isError !== true,
      text: (shaped.content ?? []).map((b) => b.text ?? '').join(''),
      value: shaped.structuredContent,
    };
  } catch (cause) {
    return { ok: false, text: cause instanceof Error ? cause.message : String(cause) };
  }
}

function Host({
  children,
  onUnexpectedState = () => undefined,
}: {
  children: React.ReactNode;
  onUnexpectedState?: (failure: unknown) => void;
}): React.ReactNode {
  return (
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'page', version: '0' }}
      validation={{ validator: testValidator }}
      onUnexpectedState={onUnexpectedState}
    >
      {children}
    </AgentMcpProvider>
  );
}

function Surface({ getState }: { getState: () => unknown }): React.ReactNode {
  useMcpState({
    name: 'customers',
    description: 'the current customer query',
    schema: SCHEMA as unknown as Record<string, unknown>,
    getState,
  });
  return null;
}

async function settled(): Promise<void> {
  await act(async () => {
    await until(async () => (await registeredNames()).length > 0, 'waited for registration');
  });
}

describe('a state read that cannot produce a value', () => {
  it('reports an execution error when getState throws, and the page stays standing', async () => {
    render(
      <Host>
        <Surface
          getState={() => {
            throw new Error('the store was not ready');
          }}
        />
      </Host>,
    );
    await settled();

    const refused = await callRegistry('customers.get_state');

    expect(refused.ok).toBe(false);
    // The page is still mounted and the tool is still declared: a failing getter is an application
    // fault, not a reason to withdraw a surface the component is still declaring.
    expect(await registeredNames()).toContain('customers.get_state');
  });

  it('refuses a value that violates the declared schema, with the OUTPUT code', async () => {
    render(
      <Host>
        <Surface getState={() => ({ secret: 'no query field' })} />
      </Host>,
    );
    await settled();

    const refused = await callRegistry('customers.get_state');

    expect(refused.ok).toBe(false);
    // Never the arguments code. The getter ALREADY RAN — and while a read is idempotent in principle,
    // an application's getter is application code and may have done anything. A caller told its
    // arguments were refused would retry.
    expect(refused.text).toContain('does not match its declared output schema');
    expect(refused.text).not.toContain(REACT_REFUSED.argumentsInvalid);
  });
});

describe('a state read after the surface is gone', () => {
  it('is REFUSED rather than answered from a dead closure', async () => {
    const { unmount } = render(
      <Host>
        <Surface getState={() => ({ query: 'live' })} />
      </Host>,
    );
    await settled();
    expect((await callRegistry('customers.get_state')).ok).toBe(true);

    unmount();
    await act(async () => {
      await until(async () => (await registeredNames()).length === 0, 'waited for withdrawal');
    });

    const refused = await callRegistry('customers.get_state');

    // Absence from the listing is not the control. The refusal is.
    expect(refused.ok).toBe(false);
  });
});

describe('what a declared schema does NOT do', () => {
  it('lets a field it never mentioned reach the caller — a contract, not a filter', async () => {
    // **This case asserts what looks like a bug, and that is deliberate.**
    //
    // `schema` is validated exactly as authored: never rewritten into a
    // closed variant, never used as an allowlist, never used to project. An undeclared field
    // therefore crosses. The next person to read this code WILL be tempted to "fix" it by adding
    // projection, and this case is what makes that fail loudly.
    //
    // The reasoning, kept here because a decision whose alternatives are lost gets re-proposed:
    //
    //   - Projecting silently turns "the author forgot a field" into "the field is absent". The two
    //     are indistinguishable to everyone downstream, which is the hidden unknown the fail-loud
    //     rule forbids by name.
    //   - Synthesizing `additionalProperties: false` and FAILING instead cannot work either. Root-only
    //     injection misses `user.token`; recursing has to understand `items`, `oneOf`, `if`/`then` and
    //     recursive `$ref`, and draft-07 `allOf` becomes unsatisfiable because closing each branch
    //     makes a sibling branch's properties illegal. The listing would advertise the author's schema
    //     while the gate enforced the rewritten one — one contract, two authorities.
    //   - And a closed schema cannot express secrecy even when perfectly implemented: a declared
    //     `token: string` passes, `user: { type: 'object' }` passes everything beneath it, and a JWT
    //     inside a declared `notes: string` passes. Shape is not sensitivity.
    //
    // What the library guarantees instead is the one thing it can keep: it traverses nothing, scans
    // nothing and injects nothing, so nothing is included AUTOMATICALLY
    // (docs/design.md#security-invariants).
    // `getState` is the disclosure boundary, and the documentation says so.
    render(
      <Host>
        <Surface
          getState={() => ({
            query: 'acme',
            undeclaredButPresent: 'this crosses, deliberately',
          })}
        />
      </Host>,
    );
    await settled();

    const read = await callRegistry('customers.get_state');

    expect(read.ok).toBe(true);
    expect(read.value).toEqual({
      query: 'acme',
      undeclaredButPresent: 'this crosses, deliberately',
    });
  });

  it('lets a field it DID declare cross, however sensitive its name looks', async () => {
    // The other half of the same decision. The library does not judge an application's field names —
    // a heuristic redactor would be guessing about someone else's data model, where a miss is silent
    // and a hit on a field named `token` that means a lexer token is a silent wrong answer.
    render(
      <Host>
        <Surface getState={() => ({ query: 'acme', secret: 'the author asked for this' })} />
      </Host>,
    );
    await settled();

    const read = await callRegistry('customers.get_state');

    expect(read.ok).toBe(true);
    expect(read.value).toEqual({ query: 'acme', secret: 'the author asked for this' });
  });
});
