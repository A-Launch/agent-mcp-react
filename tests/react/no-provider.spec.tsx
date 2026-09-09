import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REACT_REFUSED, useMcpTool } from '../../src/react/index.ts';
import {
  boundary,
  clearRegistry,
  codeOf,
  enterSecureContext,
  recorder,
  registeredNames,
} from './harness.ts';

// A hook used with no provider above it.
//
// The requirement is not "registers nothing" — a hook that quietly did nothing would satisfy that
// while leaving an application believing it instrumented an action and an agent that never sees the
// tool. That is the silent success this library exists to prevent, arriving before a call is made.
// So the assertion is the REFUSAL, and the absence is checked alongside it rather than instead of it.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(clearRegistry);

function Orphan(): null {
  useMcpTool({ name: 'orphan.tool', description: 'nowhere to go', handler: () => ({}) });
  return null;
}

describe('useMcpTool with no provider above it', () => {
  it('refuses, naming what is missing', () => {
    const seen = recorder();
    render(boundary(seen, <Orphan />));

    expect(seen.caught).toHaveLength(1);
    expect(codeOf(seen.caught[0])).toBe(REACT_REFUSED.providerMissing);
    expect(String(seen.caught[0])).toContain('AgentMcpProvider');
  });

  it('names the tool, so a reader knows which declaration is stranded', () => {
    const seen = recorder();
    render(boundary(seen, <Orphan />));

    expect(String(seen.caught[0])).toContain('orphan.tool');
  });

  it('registers nothing — checked as well as, never instead of, the refusal', async () => {
    const seen = recorder();
    render(boundary(seen, <Orphan />));

    expect(await registeredNames()).toEqual([]);
  });
});
