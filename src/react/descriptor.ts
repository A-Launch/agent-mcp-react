import type { ToolDeclaration } from '../webmcp/index.ts';

// Whether two declared descriptors are the same tool, decided by CONTENT.
//
// This file exists because of a measurement rather than a design preference. A registration effect that
// compared its inputs by identity — the ordinary React spelling — cost one withdraw-and-register cycle
// **per rerender** for every tool that declared an `inputSchema`, because an object literal written
// inline gets a new identity on every render. A tool that declared no schema cost nothing. The
// registration count stayed correct in both cases, which is how it went unnoticed.
//
// What it owns: the question "did the application change what this tool is?", and nothing else. It
// performs no I/O, touches no registry, imports no React, and holds no state — which is what lets its
// cases be a table rather than a lifecycle.
//
// What it deliberately does NOT compare: the handler. A new function identity on every render is the
// normal case, not a change, and treating it as one is the storm this whole feature prevents.

/** The fields the registry carries, and therefore the fields a change can be about. */
const COMPARED_FIELDS = ['name', 'title', 'description'] as const;

/**
 * Whether the application is declaring the same tool it declared last time.
 *
 * Invariant this function enforces: **equal content compares equal, however it was written.** Two
 * separate object literals with the same fields are the same descriptor; the same literal on two
 * renders is the same descriptor; a key written in a different order is the same descriptor.
 */
export function sameDescriptor(a: ToolDeclaration, b: ToolDeclaration): boolean {
  for (const field of COMPARED_FIELDS) {
    if (a[field] !== b[field]) return false;
  }
  return sameValue(a.inputSchema, b.inputSchema);
}

/**
 * Structural equality over a JSON Schema.
 *
 * Invariant: **structural, never a serialization.** Comparing `JSON.stringify` output would make key
 * order significant, so two descriptors an author considers identical would cycle against each other
 * forever — a storm produced by the mechanism installed to prevent one. It would also be wrong in the
 * other direction, since `undefined` disappears from a serialization and would make a declared-absent
 * field equal to a field that is not there.
 *
 * A schema is JSON: objects, arrays, strings, numbers, booleans and null. Anything else in one is an
 * authoring mistake this function reports as "different" rather than crashing on — an unequal answer
 * costs one extra cycle, where a throw from a comparison would take the application's render down.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  // Key ORDER is not compared — only membership and values. That is the whole point of not comparing a
  // serialization.
  return leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}
