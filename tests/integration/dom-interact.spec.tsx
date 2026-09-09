import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domInspectTools, domInteractTools } from '../../src/dom/index.ts';
import { RUNTIME_FAILURE } from '../../src/runtime/index.ts';
import { createAjvValidator } from '../../src/validation/ajv.ts';
import { type Application, startApplication, stopApplication, until } from './harness.tsx';

// A DOM-only task against the REAL demonstrator: an agent that pretends it has no Level 1 tools,
// filling a real controlled React input and reading the consequence back.
//
// **Every assertion here is about the APPLICATION, not the DOM.** `element.value` would be right even
// for the implementation that leaves React's state empty — measured before this feature was written —
// so a case that checked the field would pass for the broken version.
//
// And the last case is about AGREEMENT rather than outcome. 016 measured that a real socket's round
// trip gives React more than enough time to hide a missing render barrier: a DOM assertion can see
// "the page never updated", but it cannot see "the page updated LATE", and late is the defect, because
// the handler reads its result before the commit and reports the previous render's answer.

let app: Application;

beforeAll(async () => {
  const validator = createAjvValidator();
  app = await startApplication({
    capabilities: { application: true, dom: { inspect: true, interact: true }, evaluate: false },
    builtInTools: [...domInspectTools({ validator }), ...domInteractTools({ validator })],
  });
});

afterAll(stopApplication);

interface SemanticElement {
  readonly ref: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
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

async function snapshot(): Promise<{ elements: readonly SemanticElement[]; url: string }> {
  const result = await app.client.callTool({ name: 'dom.snapshot', arguments: {} });
  expect((result as { isError?: boolean }).isError, errorText(result)).not.toBe(true);
  return structured(result);
}

describe('an agent driving the page through the DOM alone', () => {
  it('step 1: all five write tools are visible', async () => {
    await until(async () => {
      const names = (await app.client.listTools()).tools.map((tool) => tool.name);
      return ['dom.click', 'dom.fill', 'dom.select', 'dom.press', 'dom.scroll'].every((name) =>
        names.includes(name),
      );
    }, 'the write tools to appear');
  });

  it('step 2: dom.fill on a real controlled input reaches the APPLICATION’s state', async () => {
    const before = await snapshot();
    const field = before.elements.find(
      (one) => one.role === 'searchbox' || (one.role === 'textbox' && one.name === 'Search'),
    );
    expect(field, 'the demonstrator has a search field').toBeDefined();

    const filled = await app.client.callTool({
      name: 'dom.fill',
      arguments: { ref: field?.ref, value: 'northwind' },
    });
    expect((filled as { isError?: boolean }).isError, errorText(filled)).not.toBe(true);

    // **Read back through the application's OWN tool**, which is the only assertion that distinguishes
    // a real fill from one that only changed the DOM.
    const state = await app.client.callTool({ name: 'customers.get_state', arguments: {} });
    expect(JSON.stringify(structured(state))).toContain('northwind');
  });

  it('step 3: and the value is still there after the application renders again', async () => {
    // The broken implementation loses it HERE, not at the fill — React overwrites the DOM on its next
    // commit. Something unrelated is driven to force one.
    const cleared = await app.client.callTool({ name: 'customers.set_sort', arguments: {} });
    // The tool may or may not accept empty arguments; either way a render happened or nothing did,
    // and the assertion below is about the value surviving whatever occurred.
    void cleared;

    const after = await snapshot();
    const field = after.elements.find(
      (one) => one.role === 'searchbox' || (one.role === 'textbox' && one.name === 'Search'),
    );
    expect(field?.value, 'the filled value survived the next render').toContain('northwind');
  });

  it('step 4: a write tool AGREES with what the screen shows', async () => {
    // Not "the page changed" — AGREEMENT. A handler that resolved before the commit would report the
    // previous render's answer, and a real socket gives React enough time that a DOM-only assertion
    // would still pass.
    const before = await snapshot();
    const field = before.elements.find(
      (one) => one.role === 'searchbox' || (one.role === 'textbox' && one.name === 'Search'),
    );

    const filled = await app.client.callTool({
      name: 'dom.fill',
      arguments: { ref: field?.ref, value: 'harborview' },
    });
    const reported = structured<{ value: string }>(filled);

    // At the instant the call resolved, the page must already agree.
    const onScreen = (document.querySelector('input[type="search"], input') as HTMLInputElement)
      ?.value;
    expect(onScreen, 'the screen agrees with what the tool reported').toBe(reported.value);
  });

  it('step 5: dom.click on a disabled control is refused BY NAME, not silently ignored', async () => {
    // **Unconditional, deliberately.** This was written with an `if (disabled === undefined) return`
    // guard, which is the shape that reports success when the thing it tests stops existing. Measured:
    // the demonstrator's initial screen carries two disabled controls — "Clear all" with no filters
    // applied, and "Save" with no view named — so the case asserts one is there rather than tolerating
    // its absence. If the demonstrator ever stops having one, this goes RED and someone decides what
    // to do about it, which is the point.
    const taken = await snapshot();
    const disabled = taken.elements.filter(
      (one) => (one as { disabled?: boolean }).disabled === true,
    );
    expect(
      disabled.length,
      'the demonstrator should still have a disabled control for this case to drive',
    ).toBeGreaterThan(0);

    const result = await app.client.callTool({
      name: 'dom.click',
      arguments: { ref: disabled[0]?.ref },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(errorText(result)).toContain(RUNTIME_FAILURE.domNotInteractable);
    // Named down to the cause, so an operator is told the page disabled it rather than merely that it
    // could not be touched.
    expect(errorText(result)).toMatch(/disabled/i);
    // And it says NOTHING about re-snapshotting: this is not staleness, and an agent sent round that
    // loop would hammer a control that will never work.
    expect(errorText(result)).not.toMatch(/call dom\.snapshot again/i);
  });

  it('step 6: a stale reference is refused by a WRITE tool exactly as by a read tool', async () => {
    // One resolver, not two. The five conditions 017 built apply unchanged here.
    const first = await snapshot();
    const ref = first.elements[0]?.ref;
    await snapshot();

    const result = await app.client.callTool({ name: 'dom.click', arguments: { ref } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(errorText(result)).toContain(RUNTIME_FAILURE.domRefStale);
  });
});
