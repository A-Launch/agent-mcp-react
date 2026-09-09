import { describe, expect, it } from 'vitest';
import { STATE_TOOL_SUFFIX, stateToolName } from '../../../src/react/use-mcp-state.ts';
import { RESERVED_PREFIX } from '../../../src/runtime/index.ts';

// The one truth `useMcpState` owns: how a surface name becomes an agent-visible tool name.
//
// Small, and worth its own file because the derivation is the thing that makes every other guarantee
// in this feature reachable. A wrong derivation produces a tool nobody can find under a name that
// looks entirely plausible — the agent lists something, the author declared something, and the two
// are different strings.

describe('the derived state tool name', () => {
  it('appends the suffix to the surface name, exactly as the state surface documents it', () => {
    expect(stateToolName('customers')).toBe('customers.get_state');
    expect(stateToolName('dashboard')).toBe('dashboard.get_state');
  });

  it('is built from the exported constant rather than a literal', () => {
    // A member of a closed set is never spelled at a call site. This is the assertion
    // that the constant is load-bearing — rename it and this fails, rather than four literals
    // elsewhere silently disagreeing with it.
    expect(stateToolName('customers')).toBe(`customers.${STATE_TOOL_SUFFIX}`);
    expect(STATE_TOOL_SUFFIX).toBe('get_state');
  });

  it('preserves a namespaced surface name rather than flattening it', () => {
    // `billing.invoices` is a legitimate surface name, and the derived tool is a third segment rather
    // than a replacement of the second.
    expect(stateToolName('billing.invoices')).toBe('billing.invoices.get_state');
  });

  it('derives a reserved name from a reserved surface name, so the existing check can see it', () => {
    // **The reason this case exists.** The reserved-prefix refusal runs against the name that reaches
    // the registry, which for a state surface is the DERIVED name. A surface named `dom` therefore
    // derives `dom.get_state`, which is reserved — and it must be, because otherwise an application
    // could reach a Level 2 namespace by declaring state rather than a tool.
    //
    // Asserted here as a property of the derivation. That the refusal actually fires is asserted where
    // the refusal lives, against a mounted component.
    for (const prefix of Object.values(RESERVED_PREFIX)) {
      const bare = prefix.endsWith('.') ? prefix.slice(0, -1) : prefix;
      expect(stateToolName(bare).startsWith(prefix)).toBe(true);
    }
  });
});
