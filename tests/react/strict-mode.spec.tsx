import { render } from '@testing-library/react';
import { StrictMode, useEffect, useRef } from 'react';
import { describe, expect, it } from 'vitest';

// The platform assumptions the lifecycle binding is built on, asserted against the renderer this
// repository actually runs.
//
// Nothing here tests library code — there is none yet. These cases exist because the registration
// lifecycle is designed around two behaviours of React that are easy to state and easy to be wrong
// about, and code that discovers it assumed the wrong one discovers it through a flaky registration
// bug rather than a failing test. If a React upgrade changes either behaviour, this file
// is where that surfaces, ahead of the code that depends on it.

describe('the renderer this repository runs', () => {
  it('double-invokes effects under StrictMode, and runs cleanup between the two', () => {
    const log: string[] = [];

    function Instrumented(): null {
      useEffect(() => {
        log.push('setup');
        return () => {
          log.push('cleanup');
        };
      }, []);
      return null;
    }

    render(
      <StrictMode>
        <Instrumented />
      </StrictMode>,
    );

    // This exact sequence is why registration cleanup must be idempotent and why one AbortController
    // per registration is scoped to the effect that created it. Cleanup that tears down a *shared*
    // resource here leaves the second setup owning nothing — the strict-mode requirement in its
    // smallest form (docs/design.md#strict-mode-and-suspense).
    expect(log).toEqual(['setup', 'cleanup', 'setup']);
  });

  it('keeps a ref stable across the StrictMode remount, so it can carry the current handler', () => {
    const seen: object[] = [];

    function Instrumented(): null {
      const ref = useRef({ marker: 'stable' });
      useEffect(() => {
        seen.push(ref.current);
      });
      return null;
    }

    render(
      <StrictMode>
        <Instrumented />
      </StrictMode>,
    );

    expect(seen).toHaveLength(2);
    // Identity, not equality. The stale-closure fix (docs/design.md#stable-handlers) depends on the
    // registered callback reading one
    // ref object for the tool's whole lifetime; a ref that were re-created would hand the second
    // registration a different box and the first one's handler would be unreachable.
    expect(seen[0]).toBe(seen[1]);
  });

  it('gives a rerender a new function identity for the same inline handler', () => {
    const identities: Array<() => void> = [];

    function Instrumented({ value }: { value: number }): null {
      const handler = (): void => {
        void value;
      };
      useEffect(() => {
        identities.push(handler);
      });
      return null;
    }

    const view = render(<Instrumented value={1} />);
    view.rerender(<Instrumented value={2} />);

    // The reason registration must never depend on handler identity. If it did, every rerender would
    // withdraw and re-register the tool, the agent would see a `tools/list_changed` storm, and there
    // would be a window in which the tool does not exist — stable handlers, and the lifecycle
    // guarantee that a rerender never touches the registry (docs/design.md#stable-handlers).
    expect(identities).toHaveLength(2);
    expect(identities[0]).not.toBe(identities[1]);
  });
});
