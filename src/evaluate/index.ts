import type { BuiltInTool } from '../runtime/built-ins.ts';
import type { SchemaValidator } from '../runtime/validation.ts';
import { CONTROL_LEVEL } from '../security/vocabulary.ts';
import { evaluateExpression } from './evaluate.ts';

// Level 3 — the subpath surface (`@agent-mcp/react/evaluate`).
//
// **Its own export so a build that never imports it never contains it** — the three levels of control
// are separate layers, and nothing short of importing this one reaches Level 3. That is the first of
// this tool's four conditions, and it is the only one an operator cannot switch on after the fact:
// code that is not in the bundle cannot be reached by any capability, any page script, or any
// mistake.
//
// Read `evaluate.ts` before changing anything here. The design's own words for what this grants are
// at the top of it, and they are not softened.

export interface EvaluateToolOptions {
  /** The same validator the provider is given. This module holds none and reaches for none. */
  readonly validator: SchemaValidator;
}

const EVALUATE_SCHEMA = {
  type: 'object',
  properties: {
    expression: {
      type: 'string',
      description:
        'JavaScript to run in the page. The body of an async function, so it may await; return a value to receive it.',
    },
  },
  required: ['expression'],
  additionalProperties: false,
} as const;

/**
 * The Level 3 tool, ready to hand to the provider's `builtInTools`.
 *
 * **It declares `confirmation: 'required'`, and it is the first built-in ever to use that field.**
 * That is the design's *"when enabled, it SHOULD be separately permissioned"* made real, and it is
 * deliberately the OPPOSITE call from the one made for `dom.click`: confirming every click of a
 * multi-step flow is a rate limit that trains people to click through, whereas this is one privileged
 * action, taken rarely, whose blast radius is the whole origin. That is the shape the confirmation
 * gate was built for.
 *
 * The resolver is shown the validated arguments — which for this tool is the code that will run,
 * because a person approving an evaluation who cannot see what will run is not approving anything.
 *
 * **Granting `evaluate` without supplying a confirmation resolver refuses every call**, with
 * `MCP_TOOL_CONFIRMATION_UNAVAILABLE`, and the tool stays LISTED. That is deliberate: it is a
 * deployment fact rather than a property of the tool, so an operator reading it fixes it by supplying
 * a resolver, and an agent is told the action exists and cannot be approved here rather than that it
 * does not exist.
 *
 * **The build mode is NOT a condition**, and that was a decision rather than an omission. Three
 * conditions already gate this and all three are in the requirement of record. A fourth keyed to the
 * build flag would give an operator who imported the subpath, granted the capability and wired a
 * resolver a tool that silently does nothing in the build they actually deployed — the "documented
 * knob that changes nothing" failure, which is a hidden unknown where a loud one is owed, and one this
 * repository has shipped before.
 * What a production build does change is that the agent is never sent a stack trace, which is already
 * the rule and already owned elsewhere.
 */
export function runtimeEvaluateTool(options: EvaluateToolOptions): readonly BuiltInTool[] {
  const schema = {
    ...EVALUATE_SCHEMA,
    properties: { ...EVALUATE_SCHEMA.properties },
    required: [...EVALUATE_SCHEMA.required],
  } as unknown as Record<string, unknown>;

  const compiled = options.validator.compile(schema);
  if (compiled instanceof Promise) {
    throw new Error(
      'runtime.evaluate needs a validator that compiles synchronously, because it is declared while an application builds its element tree and there is nowhere to await. The bundled validator does.',
    );
  }

  return [
    {
      name: 'runtime.evaluate',
      level: CONTROL_LEVEL.evaluate,
      description:
        'Run JavaScript in the page and return its value. PRIVILEGED: this is equivalent to arbitrary code execution in the application origin — it can read the DOM, application globals, storage, and anything the page can request. A person must approve each call. Use an application tool where one exists; this is a debugging instrument, never a way to reach something that was not instrumented.',
      inputSchema: schema,
      validators: { input: compiled },
      // Separately permissioned when enabled, as the design requires. The one field on a built-in
      // that nothing else uses.
      permissions: { confirmation: 'required' },
      handler: (input) => evaluateExpression(input.expression as string),
    },
  ];
}
