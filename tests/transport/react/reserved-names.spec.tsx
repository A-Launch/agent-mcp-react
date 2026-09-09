// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMcpTool } from '../../../src/react/index.ts';
import { REGISTRATION_REFUSED } from '../../../src/webmcp/index.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// A component declaring a reserved name, through the renderer, with an agent watching.
//
// The gateway suite next door drives `enqueue` and `replace` directly, which is where the ORDER
// claims are observable. What only this file can show is the pair that actually matters to the two
// audiences: **what the AGENT sees** — a name that never appears and a neighbour that goes away —
// and **what the OPERATOR is handed** in a production build, which is a report rather
// than a torn-down page.
//
// This suite runs with `NODE_ENV=test`, so `IS_DEVELOPMENT` is false and these cases exercise the
// production channel. That is deliberate rather than incidental: the development branch throws from a
// render and is asserted by the React suite, while the branch that must NOT throw is the one an
// application ships, and it is the one a mistake here would white-screen.

afterEach(closeAll);

/** A panel whose tool name is whatever it is told to declare. */
function Panel({ name }: { name: string }): ReactNode {
  useMcpTool({
    name,
    description: 'Click the thing.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ clicked: true }),
  });
  return null;
}

describe('a component declaring a reserved name', () => {
  it('never appears in the agent’s listing, and the page keeps serving', async () => {
    const page = await stack(<Panel name="dom.click" />);

    // Paired with a tool that DOES arrive, so the absence is asserted against a listing that has
    // demonstrably caught up rather than one that is merely early.
    page.setChildren(
      <>
        <Panel name="dom.click" />
        <Panel name="panel.click" />
      </>,
    );
    await until(
      async () => (await listedNames(page.client)).includes('panel.click'),
      'the neighbouring tool to reach the agent',
    );

    expect(await listedNames(page.client)).not.toContain('dom.click');
  });

  it('reports to the operator rather than tearing the page down', async () => {
    // The production half of that rule, and the case that catches the defect this feature introduced
    // once already: a refusal raised as the wrong CLASS falls through the provider's operational
    // channel to the loud one, and a shipped page white-screens over a tool name.
    const page = await stack(<Panel name="dom.click" />);

    await until(
      () => page.unexpected.some((report) => report.code === REGISTRATION_REFUSED.nameReserved),
      'the reserved-name refusal to reach the unexpected-state destination',
    );

    const report = page.unexpected.find(
      (candidate) => candidate.code === REGISTRATION_REFUSED.nameReserved,
    );
    // The name is on the report as a field, so an operator's destination can group by it without
    // parsing a sentence.
    expect((report as { subject?: string }).subject).toBe('dom.click');
    expect(report?.message).toContain('dom.click');

    // Still connected, still serving: the listing answers.
    expect(await listedNames(page.client)).toEqual([]);
  });
});

describe('a component that renames INTO a reserved name', () => {
  it('takes its previous tool away from the agent rather than leaving it behind', async () => {
    // The leak a rename into a reserved name can produce, arriving by a new route. Asserted through
    // the agent's own listing rather than through the registry, because a tool left standing under a
    // handler nothing declares is exactly a tool the agent can still see and still call.
    const page = await stack(<Panel name="panel.click" />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.click'),
      'the original tool to reach the agent',
    );

    page.setChildren(<Panel name="dom.click" />);

    await until(
      async () => !(await listedNames(page.client)).includes('panel.click'),
      'the renamed-away tool to leave the agent’s listing',
    );
    expect(await listedNames(page.client)).not.toContain('dom.click');
  });

  it('refuses the call too, not merely the listing', async () => {
    // Absence from `tools/list` is not the control; the refusal at invocation is. If the withdrawal
    // were cosmetic — the listing filtered, the registration standing — the name would still resolve
    // and the handler of a
    // render nobody declares any more would run.
    const page = await stack(<Panel name="panel.click" />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.click'),
      'the original tool to reach the agent',
    );

    page.setChildren(<Panel name="dom.click" />);
    await until(
      async () => !(await listedNames(page.client)).includes('panel.click'),
      'the renamed-away tool to leave the agent’s listing',
    );

    const result = (await page.client.callTool({ name: 'panel.click', arguments: {} })) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? '').toContain('MCP_TOOL_NOT_FOUND');
  });
});

describe('a component that renames OUT of a reserved name', () => {
  it('recovers, because the refusal withdrew nothing that existed', async () => {
    // Not symmetric with the case above, and the asymmetry is the point: the reserved registration
    // never happened, so the replacement has nothing to withdraw and must still register. A guard that
    // treated the refused declaration as live would leave the component unable to register anything
    // ever again after one bad name — a page that has to be reloaded to recover from a typo.
    const page = await stack(<Panel name="dom.click" />);
    await until(() => page.unexpected.length > 0, 'the reserved-name refusal to be reported');

    page.setChildren(<Panel name="panel.click" />);

    await until(
      async () => (await listedNames(page.client)).includes('panel.click'),
      'the corrected name to reach the agent',
    );

    // And it is callable, not merely listed — the listing is not the control in this direction either.
    const result = (await page.client.callTool({ name: 'panel.click', arguments: {} })) as {
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
  });
});

describe('a prefix is a namespace, not a substring', () => {
  it('lists `domain.set_filters`, which was never reserved', async () => {
    // The pairing for every refusal above. Without it a binding that refused any name containing
    // "dom" passes this whole file, and takes an ordinary business namespace away from every
    // application that has one.
    const page = await stack(<Panel name="domain.set_filters" />);

    await until(
      async () => (await listedNames(page.client)).includes('domain.set_filters'),
      'the application’s own namespace to reach the agent',
    );

    expect(page.unexpected).toEqual([]);
  });
});
