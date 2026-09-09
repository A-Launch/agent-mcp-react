import { describe, expect, it } from 'vitest';
import { evaluateExpression } from '../../../src/evaluate/evaluate.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';

// The mechanism, and the three things that can go wrong with it.
//
// Two of the three are discovered at CONSTRUCTION, before anything runs — which is what makes them
// answers rather than execution failures: nothing executed, and nothing changed.

function codeOf(cause: unknown): string {
  return (cause as { code?: string }).code ?? 'NO CODE';
}

describe('evaluating an expression', () => {
  it('returns what the expression produced', async () => {
    expect(await evaluateExpression('return 1 + 1;')).toEqual({ value: 2 });
  });

  it('supports an async body, so an expression may await', async () => {
    expect(await evaluateExpression('const v = await Promise.resolve(7); return v * 2;')).toEqual({
      value: 14,
    });
  });

  it('carries an object result without traversing or transforming it', async () => {
    // The result is carried, never traversed or transformed (`docs/javascript-evaluation.md#what-an-agent-gets`).
    // What comes back is what the expression produced — a sanitizer would be this
    // library deciding what an operator's own debugging expression meant.
    expect(await evaluateExpression('return { a: 1, nested: { b: [2, 3] } };')).toEqual({
      value: { a: 1, nested: { b: [2, 3] } },
    });
  });

  it('cannot see this library’s module scope', async () => {
    // The reason for `new Function` rather than `eval`. `eval` proper runs in the CALLER's scope,
    // which would be this library's — so an expression could reach the runtime's own bindings. A
    // constructed function body compiles in global scope instead.
    expect(await evaluateExpression('return typeof evaluateExpression;')).toEqual({
      value: 'undefined',
    });
    expect(await evaluateExpression('return typeof RUNTIME_FAILURE;')).toEqual({
      value: 'undefined',
    });
  });

  it('retains nothing between calls', async () => {
    // A persistent scope would be state this library holds on the agent's behalf that the confirmation
    // surface cannot see — a person approving the third call would be approving something whose
    // meaning depends on the first two.
    await evaluateExpression('globalThis.__probe_left_behind = 1; return 1;');
    expect(await evaluateExpression('return typeof left_behind;')).toEqual({ value: 'undefined' });
    Reflect.deleteProperty(globalThis as object, '__probe_left_behind');
  });
});

describe('the three things that can go wrong', () => {
  it('names a syntax error, and nothing runs', async () => {
    let ran = false;
    (globalThis as Record<string, unknown>).__ranMarker = () => {
      ran = true;
    };
    await expect(evaluateExpression('__ranMarker(); this is not javascript')).rejects.toSatisfy(
      (cause) => codeOf(cause) === RUNTIME_FAILURE.evaluateNotCompilable,
    );
    // The whole value of reporting at construction: the valid first statement never executed either.
    expect(ran, 'nothing in the expression ran').toBe(false);
    Reflect.deleteProperty(globalThis as object, '__ranMarker');
  });

  it('names a result that cannot be carried, rather than returning an empty success', async () => {
    // **The trap this case exists for.** A function and `undefined` serialize identically to nothing,
    // so an agent evaluating `() => doThing()` — forgetting to call it — would receive an empty
    // success and conclude the page returned nothing.
    await expect(evaluateExpression('return () => 1;')).rejects.toSatisfy(
      (cause) => codeOf(cause) === RUNTIME_FAILURE.evaluateResultNotCarriable,
    );
    await expect(evaluateExpression('return Symbol("x");')).rejects.toSatisfy(
      (cause) => codeOf(cause) === RUNTIME_FAILURE.evaluateResultNotCarriable,
    );
    await expect(evaluateExpression('return 1n;')).rejects.toSatisfy(
      (cause) => codeOf(cause) === RUNTIME_FAILURE.evaluateResultNotCarriable,
    );
  });

  it('names the KIND of value, never the value', async () => {
    // The result is whatever an operator's expression produced, and this is a socket.
    await evaluateExpression('return () => "SECRET_IN_A_CLOSURE";').catch((cause: Error) => {
      expect(cause.message).toContain('function');
      expect(cause.message).not.toContain('SECRET_IN_A_CLOSURE');
    });
  });

  it('reports undefined as an explicit note rather than as nothing at all', async () => {
    // `undefined` is a legitimate answer — an expression run for its side effect. It is reported as a
    // null with a note rather than as an empty body, so the agent can tell it apart from a tool that
    // failed to answer.
    expect(await evaluateExpression('return undefined;')).toEqual({
      value: null,
      note: 'the expression returned undefined',
    });
  });

  it('lets an application throw reach the caller as an ordinary failure', async () => {
    // NOT one of this module's causes: the expression compiled and ran, and the application's own
    // error is the runtime's to convert into a tool error.
    await expect(evaluateExpression('throw new Error("application says no");')).rejects.toThrow(
      'application says no',
    );
  });
});
