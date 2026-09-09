import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider } from '../../src/react/index.ts';
import { CLAIM_REFUSED, currentClaimHolder } from '../../src/webmcp/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  afterMount,
  boundary,
  clearRegistry,
  codeOf,
  enterSecureContext,
  neverConnects,
  recorder,
} from './harness.ts';

// One provider per document, and a failure that names the real cause.
//
// The registry belongs to the DOCUMENT. Two providers would keep two ownership records over one
// registry, each would classify the other's registrations as foreign, and every symptom would be the
// specified rules working correctly while pointing the reader at "some other script on the page" —
// when the cause is that this application mounted twice.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(clearRegistry);

function provider(name: string, children?: React.ReactNode) {
  return (
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name, version: '0.0.0' }}
      onUnexpectedState={() => undefined}
    >
      {children ?? <p>{name}</p>}
    </AgentMcpProvider>
  );
}

describe('a second provider in one document', () => {
  it('is refused, and the refusal names the active holder', async () => {
    const seen = recorder();
    render(
      <>
        {provider('first-app')}
        {boundary(seen, provider('second-app'))}
      </>,
    );

    await afterMount();

    expect(seen.caught).toHaveLength(1);
    expect(codeOf(seen.caught[0])).toBe(CLAIM_REFUSED.providerAlreadyActive);
    // Naming the holder is the whole point: without it the message is "a provider is already active",
    // which is the sentence a reader already knew.
    expect(String(seen.caught[0])).toContain('first-app');
  });

  it('leaves the first one holding the claim', async () => {
    const seen = recorder();
    render(
      <>
        {provider('first-app')}
        {boundary(seen, provider('second-app'))}
      </>,
    );

    await afterMount();

    // The refusal costs the page nothing that was already working.
    expect(currentClaimHolder()).toContain('first-app');
  });
});

describe('one provider, mounted more than once over time', () => {
  it('succeeds on a remount, because unmount released the claim', async () => {
    const first = render(provider('route-a'));
    await afterMount();
    expect(currentClaimHolder()).toContain('route-a');

    first.unmount();
    expect(currentClaimHolder()).toBeUndefined();

    const seen = recorder();
    render(boundary(seen, provider('route-b')));
    await afterMount();

    expect(seen.caught).toEqual([]);
    expect(currentClaimHolder()).toContain('route-b');
  });

  it('survives the double-invoked effect strict mode performs', async () => {
    const seen = recorder();
    render(<StrictMode>{boundary(seen, provider('strict-app'))}</StrictMode>);
    await afterMount();

    // Claim, release, claim — in one commit. A claim that did not release in cleanup would refuse its
    // own second mount, and every application running in development would see it.
    expect(seen.caught).toEqual([]);
    expect(currentClaimHolder()).toContain('strict-app');
  });
});
