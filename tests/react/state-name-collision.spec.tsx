import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, REACT_REFUSED, useMcpState, useMcpTool } from '../../src/index.ts';
import { REGISTRATION_REFUSED } from '../../src/webmcp/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  boundary,
  clearRegistry,
  codeOf,
  enterSecureContext,
  neverConnects,
  recorder,
  registeredNames,
  testValidator,
  until,
} from './harness.ts';

// **The collision an author cannot see on the page.**
//
// `useMcpState({ name: 'customers' })` and `useMcpTool({ name: 'customers.get_state' })` do not look
// like a collision anywhere in the source — the colliding string is written in neither of them. It
// exists because the library DERIVES one from the other, which is exactly the situation where a
// silent overwrite would be hardest to diagnose.
//
// Nothing here is new code, and that is the point of the file. Every refusal below is the existing
// registration gateway's, in the existing vocabulary, with the existing per-build reporting rule. If
// any of these needed a new branch, the composition would be weaker than the plan claims and the plan
// would be what needs correcting.

const SCHEMA = { type: 'object', properties: { query: { type: 'string' } } } as const;

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
});

afterEach(clearRegistry);

function Host({
  children,
  into,
}: {
  children: React.ReactNode;
  into: ReturnType<typeof recorder>;
}): React.ReactNode {
  return (
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'page', version: '0' }}
      validation={{ validator: testValidator }}
      onUnexpectedState={(failure) => into.unexpected.push(failure)}
    >
      {boundary(into, children)}
    </AgentMcpProvider>
  );
}

function StateSurface({ name = 'customers' }: { name?: string }): React.ReactNode {
  useMcpState({
    name,
    description: 'the current customer query',
    schema: SCHEMA as unknown as Record<string, unknown>,
    getState: () => ({ query: 'q' }),
  });
  return null;
}

function HandWritten(): React.ReactNode {
  useMcpTool({
    name: 'customers.get_state',
    description: 'a hand-declared tool that happens to occupy the derived name',
    handler: () => ({ query: 'from the hand-written tool' }),
  });
  return null;
}

describe('a derived name that is already taken', () => {
  it('is refused in the EXISTING duplicate vocabulary, with no new code for it', async () => {
    const into = recorder();
    render(
      <Host into={into}>
        <HandWritten />
        <StateSurface />
      </Host>,
    );
    await act(async () => {
      await until(
        async () => into.caught.length > 0 || into.unexpected.length > 0,
        'waited for the collision to be reported',
      );
    });

    const codes = [...into.caught, ...into.unexpected].map(codeOf);

    // The duplicate code that already existed. A second vocabulary for this condition would put one
    // truth under two owners, where the rule is one owner per truth. A receiver branching on the
    // code would have to learn a
    // new member for a condition it already handles.
    expect(codes).toContain(REGISTRATION_REFUSED.nameHeldByThisApplication);
  });

  it('leaves the original registration standing', async () => {
    const into = recorder();
    render(
      <Host into={into}>
        <HandWritten />
        <StateSurface />
      </Host>,
    );
    await act(async () => {
      await until(
        async () => into.caught.length > 0 || into.unexpected.length > 0,
        'waited for the collision to be reported',
      );
    });

    // Exactly one tool holds the name, and it is the one that got there first. A refusal that
    // withdrew the original would turn a collision into an outage for a tool that was working.
    expect(await registeredNames()).toEqual(['customers.get_state']);
  });

  it('applies equally to two state surfaces of the same name', async () => {
    const into = recorder();
    render(
      <Host into={into}>
        <StateSurface />
        <StateSurface />
      </Host>,
    );
    await act(async () => {
      await until(
        async () => into.caught.length > 0 || into.unexpected.length > 0,
        'waited for the collision to be reported',
      );
    });

    expect([...into.caught, ...into.unexpected].map(codeOf)).toContain(
      REGISTRATION_REFUSED.nameHeldByThisApplication,
    );
    expect(await registeredNames()).toEqual(['customers.get_state']);
  });
});

describe('a surface whose DERIVED name is reserved', () => {
  it('is refused, because the check runs against what reaches the registry', async () => {
    // A surface named `dom` derives `dom.get_state`, which is reserved. It MUST be refused: otherwise
    // an application could occupy a Level 2 namespace by declaring state rather than a tool, and a
    // tool's level comes from the table it was found in — the registry's, which is Level 1. The name
    // would be the lie and no later check could recover the distinction.
    const into = recorder();
    render(
      <Host into={into}>
        <StateSurface name="dom" />
      </Host>,
    );
    await act(async () => {
      await until(
        async () => into.caught.length > 0 || into.unexpected.length > 0,
        'waited for the reserved-name refusal',
      );
    });

    expect([...into.caught, ...into.unexpected].map(codeOf)).toContain(
      REGISTRATION_REFUSED.nameReserved,
    );
    expect(await registeredNames()).toEqual([]);
  });
});

describe('a surface declared with no schema', () => {
  it('is refused synchronously, at declaration', async () => {
    // Its own code rather than a borrowed one. `validatorMissing` would tell an author to install a
    // validator when their mistake is a missing schema, sending them somewhere they cannot fix
    // anything; `REGISTRATION_REFUSED` lives in `src/webmcp/`, which must not learn what a state
    // surface is.
    const into = recorder();

    function NoSchema(): React.ReactNode {
      // @ts-expect-error the required schema is deliberately omitted — this is the untyped-consumer
      // path, and `pnpm test` CANNOT see this directive because Vitest strips types without checking
      // them. `pnpm typecheck` is what covers the compile-time half.
      useMcpState({
        name: 'customers',
        description: 'the current customer query',
        getState: () => ({ query: 'q' }),
      });
      return null;
    }

    render(
      <Host into={into}>
        <NoSchema />
      </Host>,
    );
    await act(async () => {
      await until(
        async () => into.caught.length > 0 || into.unexpected.length > 0,
        'waited for the missing-schema refusal',
      );
    });

    expect([...into.caught, ...into.unexpected].map(codeOf)).toContain(
      REACT_REFUSED.stateSchemaMissing,
    );
    expect(await registeredNames()).toEqual([]);
  });

  it('is loud rather than reported operationally, unlike a duplicate name', async () => {
    // **The asymmetry, asserted rather than assumed**, because it looks inconsistent until the reason
    // is stated. A duplicate is an ENVIRONMENTAL collision: the page runs correctly without that one
    // tool, and tearing it down would be worse than the collision — so production preserves and
    // reports. A missing schema is an INCOHERENT DECLARATION: there is no version of the page where
    // it is right, and it can only reach a build through untyped consumption.
    const into = recorder();

    function NoSchema(): React.ReactNode {
      // @ts-expect-error see above — deliberately omitted
      useMcpState({ name: 'customers', description: 'd', getState: () => ({}) });
      return null;
    }

    render(
      <Host into={into}>
        <NoSchema />
      </Host>,
    );
    await act(async () => {
      await until(async () => into.caught.length > 0, 'waited for the throw');
    });

    // It reaches the error boundary — the loud channel — rather than the operator's destination.
    expect(into.caught.map(codeOf)).toContain(REACT_REFUSED.stateSchemaMissing);
  });
});
