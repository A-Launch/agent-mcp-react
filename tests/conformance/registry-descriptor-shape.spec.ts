// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { toDescriptor } from '../../src/webmcp/descriptor.ts';

// **What this library puts into the registry, against what the standard's dictionary declares.**
//
// Normative, at the pinned commit (`evidence/webmcp-41d12f0.bs`):
//
//     dictionary ModelContextTool {
//       required DOMString name;
//       USVString title;
//       required DOMString description;
//       object inputSchema;
//       required ToolExecuteCallback execute;
//       ToolAnnotations annotations;
//     };
//
// **`outputSchema` appears ZERO times in the normative source.** That confirms the claim in
// `src/runtime/listing.ts` — *"the document registry's descriptor has no such field"* — which a design
// decision rests on: an output schema is held on the ownership record and carried into the derived
// listing, because it cannot come back from the registry.
//
// The RESOLVED PACKAGE implements `outputSchema` anyway, as an extension, and validates against it.
// This project does not set it, so it is unaffected — but the divergence is recorded, because an
// application that set the field directly would get validation on the polyfill and silence on a
// conformant registry.
//
// This case exists so that "we do not send it" stays a fact rather than a habit.

describe('the descriptor this library sends', () => {
  it('carries only fields the standard’s dictionary declares', () => {
    const descriptor = toDescriptor({
      name: 'shape.probe',
      title: 'Shape probe',
      description: 'a tool for asserting the descriptor shape',
      inputSchema: { type: 'object', properties: {} },
      handler: () => 'ok',
    });

    // Every key the normative ModelContextTool dictionary declares.
    const permitted = new Set([
      'name',
      'title',
      'description',
      'inputSchema',
      'execute',
      'annotations',
    ]);
    const sent = Object.keys(descriptor);
    const undeclared = sent.filter((key) => !permitted.has(key));

    expect(
      undeclared,
      `these fields are not in ModelContextTool and would be ignored by a conformant registry:\n${undeclared.join('\n')}`,
    ).toEqual([]);
  });

  it('sends NO outputSchema, which the standard does not have', () => {
    const descriptor = toDescriptor({
      name: 'shape.output',
      description: 'declares no output schema at the registry boundary',
      handler: () => ({ total: 1 }),
    });
    expect('outputSchema' in descriptor).toBe(false);
  });

  it('sends no annotations, which is a decision rather than an omission', () => {
    // `descriptor.ts` records why: the standard's annotations are hints to a caller and never
    // enforcement, and this project derives risk from its own vocabulary. Asserted so a future edit
    // that started forwarding them is a deliberate change rather than a drift.
    const descriptor = toDescriptor({
      name: 'shape.annotations',
      description: 'declares nothing about annotations',
      handler: () => 'ok',
    });
    expect('annotations' in descriptor).toBe(false);
  });
});
