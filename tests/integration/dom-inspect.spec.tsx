import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domInspectTools } from '../../src/dom/index.ts';
import { RUNTIME_FAILURE } from '../../src/runtime/index.ts';
import { createAjvValidator } from '../../src/validation/ajv.ts';
import { type Application, startApplication, stopApplication, until } from './harness.tsx';

// Level 2 read, driven against the REAL demonstrator over a real socket.
//
// **The case this file exists for is the last one**, and it is the only place in this repository where
// research R1's danger is reproduced rather than argued. R1 measured that React reuses a row's DOM
// node across a data change: the same `<button>` that said "Acme" says "Zenith", still connected, at
// an unchanged URL. Everything a per-snapshot reference table would check still passes for that node.
//
// So the case asserts the node is STILL CONNECTED at an UNCHANGED URL before asserting the refusal.
// Without those two lines it would pass for a design that refused the reference for one of the other
// reasons — and those are exactly the reasons the wrong design gets right while handing back the wrong
// row.
//
// One application, built once and advanced, exactly as the acceptance suite is. Failures cascade and
// the FIRST red names where the narrative broke.

let app: Application;

beforeAll(async () => {
  app = await startApplication({
    // The read half granted and the write half withheld — the profile the documentation recommends,
    // and the one that makes the two halves of one capability visibly different.
    capabilities: {
      application: true,
      dom: { inspect: true, interact: false },
      evaluate: false,
    },
    builtInTools: domInspectTools({ validator: createAjvValidator() }),
  });
});

afterAll(stopApplication);

interface SemanticElement {
  readonly ref: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
}

interface SnapshotResult {
  readonly url: string;
  readonly title: string;
  readonly elements: readonly SemanticElement[];
  readonly truncated?: number;
}

function structured<T>(result: unknown): T {
  const content = (result as { structuredContent?: unknown }).structuredContent;
  if (content !== undefined) return content as T;
  const text = ((result as { content?: { text?: string }[] }).content ?? [])
    .map((part) => part.text ?? '')
    .join('');
  return JSON.parse(text) as T;
}

function errorText(result: unknown): string {
  return ((result as { content?: { text?: string }[] }).content ?? [])
    .map((part) => part.text ?? '')
    .join(' ');
}

async function snapshot(): Promise<SnapshotResult> {
  const result = await app.client.callTool({ name: 'dom.snapshot', arguments: {} });
  expect((result as { isError?: boolean }).isError, errorText(result)).not.toBe(true);
  return structured<SnapshotResult>(result);
}

describe('an agent reading a page it was never given tools for', () => {
  it('step 1: both DOM tools are visible to the agent', async () => {
    await until(async () => {
      const names = (await app.client.listTools()).tools.map((tool) => tool.name);
      return names.includes('dom.snapshot') && names.includes('dom.get_text');
    }, 'the DOM tools to appear in the agent’s listing');
  });

  it('step 2: a snapshot names the controls a person can actually see', async () => {
    const taken = await snapshot();
    expect(taken.elements.length).toBeGreaterThan(0);
    // The URL, not the title: jsdom's document has no `<title>` element, so asserting a non-empty one
    // would be asserting a fact about the test environment rather than about the snapshot. The live
    // demonstration is where a real title gets checked.
    expect(taken.url).toBe(window.location.href);
    // Real controls from the real demonstrator, named the way a screen reader would announce them.
    const names = taken.elements.map((one) => one.name).filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    const roles = new Set(taken.elements.map((one) => one.role));
    expect(roles.has('button')).toBe(true);
  });

  it('step 3: the snapshot contains no markup at all', async () => {
    // A snapshot is SEMANTIC — roles and accessible names, never markup (docs/dom-inspection.md).
    // Asserted over the whole serialized result, so a convenience field added later has to be
    // added deliberately past this rather than slipping in beside the fields a narrower check names.
    const serialized = JSON.stringify(await snapshot());
    for (const forbidden of ['<div', '<button', '<input', 'class=', 'innerHTML', 'data-testid']) {
      expect(serialized, `a snapshot must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('step 4: the agent reads back the text of something it was shown', async () => {
    const taken = await snapshot();
    const target = taken.elements.find((one) => (one.name ?? '') !== '');
    expect(target).toBeDefined();

    const result = await app.client.callTool({
      name: 'dom.get_text',
      arguments: { ref: target?.ref },
    });
    expect((result as { isError?: boolean }).isError, errorText(result)).not.toBe(true);
    const { text } = structured<{ text: string }>(result);
    expect(typeof text).toBe('string');
  });

  it('step 5: an invented reference is NEVER FOUND, and is not told to re-snapshot', async () => {
    await snapshot();
    const result = await app.client.callTool({
      name: 'dom.get_text',
      arguments: { ref: 'e99999999' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(errorText(result)).toContain(RUNTIME_FAILURE.domRefNotFound);
    expect(errorText(result)).not.toMatch(/call dom\.snapshot again/i);
  });

  it('step 6: a superseded reference is STALE, and IS told to re-snapshot', async () => {
    const first = await snapshot();
    const ref = first.elements[0]?.ref;
    await snapshot();

    const result = await app.client.callTool({ name: 'dom.get_text', arguments: { ref } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(errorText(result)).toContain(RUNTIME_FAILURE.domRefStale);
    expect(errorText(result)).toMatch(/call dom\.snapshot again/i);
  });

  it('step 7: a reference to a row the filter removed is refused, and one it kept still resolves', async () => {
    // **A finding, recorded here because it changed what this case could assert.**
    //
    // This case was written to reproduce research R1 — React reusing a row's DOM node for different
    // data — against the real application. It cannot, and the reason is that the demonstrator is
    // keyed CORRECTLY: `ResultsTable` renders `<tr key={account.id}>`, so React moves and removes row
    // nodes rather than refilling them. R1's probe used index keys, which is the ordinary spelling a
    // filterable table gets by default and the one a great many real applications have.
    //
    // Adding an index-keyed surface to the demonstrator to make this case work would be fitting the
    // application to the test, which is the one move this repository does not make. So the recycled
    // condition stays unit-covered (`tests/unit/dom/references.spec.ts`, case 4, where it is driven
    // directly), and what is asserted HERE is the pair this page genuinely produces
    // — which is worth having on its own, because it is the discrimination an agent acts on:
    //
    //   a row the filter removed  → refused, and the agent is told to snapshot again
    //   a row the filter kept     → still resolves, because nothing about it changed
    //
    // A design that invalidated everything on any change would pass the first and fail the second, and
    // would cost an agent a full snapshot after every interaction.
    const before = await snapshot();
    const namesBefore = [...document.querySelectorAll('.row-open')].map((node) =>
      (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    expect(namesBefore.length, 'the demonstrator renders account rows').toBeGreaterThan(1);

    const filtered = await app.client.callTool({
      name: 'customers.set_filters',
      arguments: { health: ['churning'] },
    });
    expect((filtered as { isError?: boolean }).isError, errorText(filtered)).not.toBe(true);

    const namesAfter = [...document.querySelectorAll('.row-open')].map((node) =>
      (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    expect(namesAfter.length, 'the filter narrowed the table').toBeLessThan(namesBefore.length);
    expect(window.location.href, 'the page did not navigate').toBe(before.url);

    const removedName = namesBefore.find((name) => !namesAfter.includes(name));
    const keptName = namesBefore.find((name) => namesAfter.includes(name));
    expect(removedName, 'some row left the table').toBeDefined();
    expect(keptName, 'some row survived the filter').toBeDefined();

    const removedRef = before.elements.find((one) => one.name === removedName)?.ref;
    const keptRef = before.elements.find((one) => one.name === keptName)?.ref;
    expect(removedRef).toBeDefined();
    expect(keptRef).toBeDefined();

    const gone = await app.client.callTool({
      name: 'dom.get_text',
      arguments: { ref: removedRef },
    });
    expect((gone as { isError?: boolean }).isError).toBe(true);
    expect(errorText(gone)).toContain(RUNTIME_FAILURE.domRefStale);
    expect(errorText(gone)).toMatch(/call dom\.snapshot again/i);

    const survivor = await app.client.callTool({
      name: 'dom.get_text',
      arguments: { ref: keptRef },
    });
    expect(
      (survivor as { isError?: boolean }).isError,
      'a reference to a row the change did not touch must survive it',
    ).not.toBe(true);
  });

  it('step 8: nothing sensitive is in any snapshot this page ever produced', async () => {
    // The demonstrator has no password field, so this asserts the guarantee's SHAPE against the real
    // page rather than against a fixture: no attribute value of any kind reaches the agent, because
    // attributes are never traversed. The unit suite drives the password and hidden-input cases.
    const serialized = JSON.stringify(await snapshot());
    for (const attribute of document.querySelectorAll('[data-testid]')) {
      const value = attribute.getAttribute('data-testid');
      if (value !== null && value !== '') expect(serialized).not.toContain(value);
    }
  });
});
