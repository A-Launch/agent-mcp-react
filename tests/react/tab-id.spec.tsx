import { render } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useMcpTabId } from '../../src/index.ts';
import { pageInstanceId } from '../../src/page-identity.ts';
import { renderOutsideAct } from './harness.ts';

// What an application observes about its page instance's identity.
//
// The claims here are lifecycle claims, so they are asserted against the renderer rather than against
// the module: the module's own uniqueness and refusal cases live in `tests/unit/page-identity.spec.ts`,
// and repeating them here would be testing the same thing twice under a more expensive harness.
//
// **Every case compares the identity to itself across an event.** Asserting merely that a value is
// present would pass against an implementation that minted a fresh one per render — which is precisely
// the defect these exist to catch, and the one whose symptom is an agent addressing a page it cannot
// reach twice in a row.

/** Records what the hook returned on every render of one component. */
function reader(seen: string[]): () => null {
  return function Reader(): null {
    seen.push(useMcpTabId());
    return null;
  };
}

describe('an application reading its page identity', () => {
  it('gets a value in the first render, with no provider above it', () => {
    const seen: string[] = [];
    const Reader = reader(seen);
    render(<Reader />);

    // Two claims in one assertion, and both are the clarified decision. There is no absent case for a
    // caller to handle — so nobody can append a placeholder to a connection URL by forgetting one —
    // and an identity does not wait for a provider, because it is a fact about the page rather than
    // about a connection.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/\S/);
  });

  it('is the same value on a rerender', () => {
    const seen: string[] = [];
    function Host(): React.ReactElement {
      const [, bump] = useState(0);
      seen.push(useMcpTabId());
      return (
        <button type="button" onClick={() => bump((n) => n + 1)}>
          rerender
        </button>
      );
    }

    const { rerender } = render(<Host />);
    rerender(<Host />);
    rerender(<Host />);

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(1);
  });

  it('is the same value after an unmount and a remount', () => {
    const seen: string[] = [];
    const Reader = reader(seen);

    const first = render(<Reader />);
    first.unmount();
    render(<Reader />);

    // A provider remount, a route change and a hot reload all reach here. The identity belongs to the
    // page instance, not to a mount — an identity that changed here would give an agent a new address
    // for a page it was already talking to.
    expect(new Set(seen).size).toBe(1);
  });

  it('is the same value under StrictMode, which mounts, unmounts and mounts again', () => {
    const seen: string[] = [];
    const Reader = reader(seen);

    render(
      <StrictMode>
        <Reader />
      </StrictMode>,
    );

    // StrictMode's double invocation is the cheapest simulation of a remount there is, and the one an
    // author meets first. A per-mount identity passes every case above and fails this one.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(1);
  });

  it('is the same value to a caller in a LATER task, which is how every agent call arrives', async () => {
    const seen: string[] = [];
    const Reader = reader(seen);

    // Outside `act()` on purpose. `act()` flushes passive effects synchronously, so an implementation
    // that derived the identity in an effect would look correct under React Testing Library and be
    // wrong for the callers that matter. The harness records why this helper exists for exactly one
    // other case; this is the second.
    const mounted = renderOutsideAct(<Reader />);
    // Outside `act()` the root renders asynchronously, so the first value is not readable until the
    // turn yields. Waiting for it is the point rather than an inconvenience: what this case measures is
    // what a caller arriving in a LATER task sees, and that is the same vantage point.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstCommit = seen[0];

    mounted.rerender(<Reader />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstCommit).toMatch(/\S/);
    expect(new Set(seen).size).toBe(1);
    mounted.unmount();
  });

  it('publishes the page instance identity itself, not a value of its own', () => {
    const seen: string[] = [];
    const Reader = reader(seen);
    render(<Reader />);

    // **Added after a break-it left this suite GREEN.** Replacing the hook's body with the constant
    // `'dashboard'` — the literal the demonstrator used to carry — turned the transport cases red and
    // every case here stayed passing, because a constant satisfies every stability claim above.
    // Stability and identity are different properties, and this file was only asserting the first.
    expect(seen[0]).toBe(pageInstanceId());
  });

  it('is the same value in two components that never share a parent', () => {
    const left: string[] = [];
    const right: string[] = [];
    const Left = reader(left);
    const Right = reader(right);

    render(<Left />);
    render(<Right />);

    // The identity is document-scoped, not context-scoped. Two unrelated subtrees — the case a
    // micro-frontend produces — must agree, and no provider or context is involved in making them.
    expect(right[0]).toBe(left[0]);
  });
});
