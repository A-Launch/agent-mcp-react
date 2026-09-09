import { render } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider } from '../../src/react/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  afterMount,
  clearRegistry,
  enterSecureContext,
  neverConnects,
  registeredNames,
} from './harness.ts';

// What a render that never commits must leave behind: nothing.
//
// This is registration-after-commit and the Suspense rule in their smallest form
// (docs/design.md#registration-follows-the-commit, docs/design.md#strict-mode-and-suspense).
// A provider that resolved a registry during render would install a portability shim into the
// document of every application that rendered it —
// including one whose render was thrown away — and an aborted render would leave a page instrumented
// by a component that does not exist.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(clearRegistry);

/** Suspends forever, so the boundary's content is rendered and never committed. */
function NeverReady(): null {
  throw new Promise<void>(() => undefined);
}

describe('a render that never commits', () => {
  it('resolves no registry, installs nothing and attempts no connection', async () => {
    render(
      <Suspense fallback={null}>
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: neverConnects }}
          server={{ name: 'never-committed', version: '0.0.0' }}
          onUnexpectedState={() => undefined}
        >
          <NeverReady />
        </AgentMcpProvider>
      </Suspense>,
    );

    await afterMount();

    // Asserted against the document rather than against the library: the question is what a page
    // script would find, and the library's own view of it is not the answer.
    expect((document as unknown as { modelContext?: unknown }).modelContext).toBeUndefined();
    expect(await registeredNames()).toEqual([]);
  });
});
