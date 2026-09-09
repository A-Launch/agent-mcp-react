import { describe, expect, it } from 'vitest';
import { sameDescriptor } from '../../../src/react/descriptor.ts';
import type { ToolDeclaration } from '../../../src/webmcp/index.ts';

// The comparison that decides whether the registry is touched at all, as a table.
//
// It is a table because this is the file a future descriptor field is added to, and a table is where an
// omission shows up as a missing row rather than as a field nobody compares. A field the registry
// carries and this function ignores is a change an agent never learns about.

const base = (over: Partial<ToolDeclaration> = {}): ToolDeclaration => ({
  name: 'a.tool',
  description: 'does a thing',
  handler: () => ({ ok: true }),
  ...over,
});

describe('two descriptors are the same tool', () => {
  const same: Array<[string, ToolDeclaration, ToolDeclaration]> = [
    ['written as separate literals with equal content', base(), base()],
    [
      'with equal inline schemas',
      base({ inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }),
      base({ inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }),
    ],
    [
      'with the same schema keys written in a different order',
      base({ inputSchema: { type: 'object', properties: {}, required: [] } }),
      base({ inputSchema: { required: [], properties: {}, type: 'object' } }),
    ],
    [
      'with equal nested schemas',
      base({
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'array', items: { type: 'number' } } },
        },
      }),
      base({
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'array', items: { type: 'number' } } },
        },
      }),
    ],
    // The case the whole feature turns on: a handler is a new function on every render, and that is
    // the normal condition rather than a change.
    ['with different handler identities', base({ handler: () => 1 }), base({ handler: () => 2 })],
    ['with both titles absent', base(), base()],
    ['with equal titles', base({ title: 'A tool' }), base({ title: 'A tool' })],
  ];

  for (const [label, a, b] of same) {
    it(label, () => {
      expect(sameDescriptor(a, b)).toBe(true);
      expect(sameDescriptor(b, a)).toBe(true);
    });
  }
});

describe('two descriptors are different tools', () => {
  const different: Array<[string, ToolDeclaration, ToolDeclaration]> = [
    ['a different name', base(), base({ name: 'b.tool' })],
    ['a different description', base(), base({ description: 'does another thing' })],
    ['a title added', base(), base({ title: 'A tool' })],
    ['a different title', base({ title: 'A' }), base({ title: 'B' })],
    ['a schema added', base(), base({ inputSchema: { type: 'object', properties: {} } })],
    [
      'a schema property added',
      base({ inputSchema: { type: 'object', properties: {} } }),
      base({ inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }),
    ],
    [
      'a schema value changed deeply',
      base({ inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }),
      base({ inputSchema: { type: 'object', properties: { a: { type: 'number' } } } }),
    ],
    [
      'an array element order changed — order IS significant inside a schema',
      base({ inputSchema: { type: 'object', required: ['a', 'b'] } }),
      base({ inputSchema: { type: 'object', required: ['b', 'a'] } }),
    ],
    [
      'an array length changed',
      base({ inputSchema: { type: 'object', required: ['a'] } }),
      base({ inputSchema: { type: 'object', required: ['a', 'b'] } }),
    ],
  ];

  for (const [label, a, b] of different) {
    it(label, () => {
      expect(sameDescriptor(a, b)).toBe(false);
      expect(sameDescriptor(b, a)).toBe(false);
    });
  }
});

describe('the comparison is not a serialization', () => {
  it('does not treat a declared-undefined field as an absent one', () => {
    // `JSON.stringify` drops `undefined`, so a serialization comparison would call these equal. They
    // are not: one schema declares a key and the other does not.
    const declared = base({
      inputSchema: { type: 'object', a: undefined } as Record<string, unknown>,
    });
    const absent = base({ inputSchema: { type: 'object' } });
    expect(sameDescriptor(declared, absent)).toBe(false);
  });

  it('reports a value it cannot compare as different rather than throwing', () => {
    // A function in a schema is an authoring mistake. Answering "different" costs one extra cycle; a
    // throw from inside a comparison would take the application's render down with it.
    const withFunction = base({
      inputSchema: { type: 'object', bad: () => 1 } as Record<string, unknown>,
    });
    const other = base({
      inputSchema: { type: 'object', bad: () => 1 } as Record<string, unknown>,
    });
    expect(sameDescriptor(withFunction, other)).toBe(false);
  });
});
