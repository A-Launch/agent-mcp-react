import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../src/react/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  boundary,
  clearRegistry,
  enterSecureContext,
  neverConnects,
  recorder,
  registeredNames,
  until,
} from './harness.ts';

// The case this feature is shaped around, and the one whose obvious half is not enough.
//
// Under strict mode the renderer performs setup / cleanup / setup for every effect in one commit. With
// one controller per registration and an abort in cleanup — the shape the lifecycle rule's wording
// invites (gone at unmount, idempotent cleanup, nothing left behind by strict mode), and the shape
// anybody writes first — two registrations of ONE name are in flight at once,
// because registration is asynchronous and effects are not.
//
// What makes it a trap is the outcome. Measured, with each attempt labelled:
//
//     attempt-1:setup → attempt-1:cleanup → attempt-2:setup
//     → attempt-2:registered → attempt-1:refused
//     surviving: ['attempt-2']
//
// Exactly one registration, and the right one. A case asserting only the count passes against a
// broken mechanism, while the author receives a spurious refusal on every mount in development —
// misdiagnosed, before this feature, as a name held by a script that does not exist.
//
// So both halves are asserted here: the count AND that nothing was raised. Deleting the gateway's
// per-name serialization must turn the second half red. If only the first half fails, this case is
// under-specified and the check must not be restored until it is strengthened.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(clearRegistry);

function Tool({ name }: { name: string }): null {
  useMcpTool({
    name,
    description: `the ${name} tool`,
    handler: () => ({ ok: true }),
  });
  return null;
}

function mount(seen: ReturnType<typeof recorder>, children: React.ReactNode) {
  return render(
    <StrictMode>
      {boundary(
        seen,
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: neverConnects }}
          server={{ name: 'strict-page', version: '0.0.0' }}
          onUnexpectedState={(failure) => seen.unexpected.push(failure)}
        >
          {children}
        </AgentMcpProvider>,
      )}
    </StrictMode>,
  );
}

describe('a mount / cleanup / mount sequence, which strict mode performs for every effect', () => {
  it('leaves exactly one registration', async () => {
    const seen = recorder();
    mount(seen, <Tool name="strict.tool" />);

    await until(
      async () => (await registeredNames()).includes('strict.tool'),
      'the tool to register',
    );
    expect(await registeredNames()).toEqual(['strict.tool']);
  });

  it('raises no refusal doing it — the half a count assertion cannot see', async () => {
    const seen = recorder();
    mount(seen, <Tool name="strict.tool" />);

    await until(
      async () => (await registeredNames()).includes('strict.tool'),
      'the tool to register',
    );

    // The withdrawn attempt is skipped, never attempted. If it reaches the registry instead, it is
    // refused, the refusal travels the provider's throw channel, and this boundary catches it — while
    // the assertion above keeps passing.
    expect(seen.caught).toEqual([]);
  });

  it('leaves no ownership entry the registry does not back', async () => {
    const seen = recorder();
    mount(seen, <Tool name="strict.tool" />);

    await until(
      async () => (await registeredNames()).includes('strict.tool'),
      'the tool to register',
    );

    // An entry for a registration that did not happen is a divergence this library manufactured
    // itself, and the runtime would report it as one — training an operator to ignore the alarm that
    // exists to catch a real fault.
    expect(seen.unexpected).toEqual([]);
  });

  it('registers two different tools without serializing them behind each other', async () => {
    const seen = recorder();
    mount(
      seen,
      <>
        <Tool name="strict.first" />
        <Tool name="strict.second" />
      </>,
    );

    await until(async () => (await registeredNames()).length === 2, 'both tools to register');
    expect((await registeredNames()).sort()).toEqual(['strict.first', 'strict.second']);
    expect(seen.caught).toEqual([]);
  });
});
