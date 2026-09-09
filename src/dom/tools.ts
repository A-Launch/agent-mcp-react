import type { BuiltInTool } from '../runtime/built-ins.ts';
import { RUNTIME_FAILURE, RuntimeError } from '../runtime/errors.ts';
import type { CompiledSchema, SchemaValidator } from '../runtime/validation.ts';
import { CONTROL_LEVEL, DOM_AUTHORITY } from '../security/vocabulary.ts';
import {
  applyFill,
  applyPress,
  applyScroll,
  applySelect,
  fillabilityOf,
  type Interactability,
  interactabilityOf,
  NOT_INTERACTABLE,
  type NotInteractable,
} from './interact.ts';
import {
  isScrollDirection,
  PRESSABLE_KEY_VALUES,
  SCROLL_DIRECTION_VALUES,
  type ScrollDirection,
} from './keys.ts';
import { REFERENCE_REFUSAL, type ReferenceRefusal, resolveReference } from './references.ts';
import { takeSnapshot, textOf } from './snapshot.ts';

// The two Level 2 read tools, as entries for the runtime's built-in table.
//
// **These are NEVER registered.** They do not enter the document's shared tool registry in any
// configuration, including one whose capability set grants `dom.inspect` (invariant 16 in
// `docs/design.md#security-invariants`) — anything in that registry is invokable by every script on the
// page with not one gate in the path, and a registered DOM tool would be a page-wide reader that no
// capability could take back. They exist only in the table this module hands to the provider, and the
// only route to them is the bridged `tools/call` handler.
//
// **No capability check lives here**. The gate is in the runtime, because a module that
// decides whether it may run is a module that can be imported past its own check. What these entries
// DECLARE is their level and which half of the DOM authority they need; the runtime decides.
//
// **No validator lives here either.** `dom.get_text` declares an input schema, and
// `buildBuiltInTable()` refuses an entry that advertises a contract with no compiled validator —
// exactly the rule an application's tool lives under. The factory takes one from its caller.

/** The one argument `dom.get_text` accepts. Declared, and therefore enforced before the handler runs. */
const GET_TEXT_SCHEMA = {
  type: 'object',
  properties: {
    ref: {
      type: 'string',
      description: 'A reference token from the most recent dom.snapshot, such as "e12".',
    },
  },
  required: ['ref'],
  additionalProperties: false,
} as const;

/**
 * How each refusal reaches the agent.
 *
 * Derived from the refusal dictionary rather than spelled at each site, because a closed set is
 * declared once and everything else derives from it — which is what makes a new refusal cause a
 * compile error here instead of a silent fall-through to a default.
 *
 * **The split is the point** (spec Q3): STALE tells the agent to snapshot again, because something it
 * was correctly told stopped being true. NOT_FOUND deliberately does not — re-snapshotting cannot
 * conjure a token nobody minted, and sending an agent round that loop turns a wrong argument into a
 * retry storm.
 */
const REFUSAL_REPORT: Readonly<
  Record<ReferenceRefusal, { code: RuntimeError['code']; message: string }>
> = {
  [REFERENCE_REFUSAL.neverIssued]: {
    code: RUNTIME_FAILURE.domRefNotFound,
    message:
      'this page never issued that element reference. Check the reference you were given; references from another tab or another page are not valid here.',
  },
  [REFERENCE_REFUSAL.supersededBySnapshot]: {
    code: RUNTIME_FAILURE.domRefStale,
    message: 'a newer snapshot replaced that reference. Call dom.snapshot again.',
  },
  [REFERENCE_REFUSAL.elementRemoved]: {
    code: RUNTIME_FAILURE.domRefStale,
    message: 'that element is no longer on the page. Call dom.snapshot again.',
  },
  [REFERENCE_REFUSAL.pageNavigated]: {
    code: RUNTIME_FAILURE.domRefStale,
    message: 'the page navigated after that snapshot was taken. Call dom.snapshot again.',
  },
  [REFERENCE_REFUSAL.elementRecycled]: {
    code: RUNTIME_FAILURE.domRefStale,
    message:
      'that element no longer matches what the snapshot reported for it — the page reused it for different content. Call dom.snapshot again.',
  },
  [REFERENCE_REFUSAL.invalidatedByApplication]: {
    code: RUNTIME_FAILURE.domRefStale,
    message: 'the application invalidated element references. Call dom.snapshot again.',
  },
};

/**
 * The document these tools read.
 *
 * Refused loudly when there is none rather than defaulting to something empty: a snapshot that
 * silently returned no elements would tell an agent the page is blank, which is a wrong answer that
 * looks entirely normal — an unexpected state fails loud, never hides behind a convenience default.
 */
function requireDocument(): Document {
  const document = globalThis.document;
  if (document === undefined || document === null) {
    throw new RuntimeError(
      RUNTIME_FAILURE.toolExecutionFailed,
      'there is no document to inspect — the DOM tools are browser-only',
    );
  }
  return document;
}

/**
 * Resolves a reference or throws the refusal the agent will receive.
 *
 * The two DOM codes are members of the runtime's `HANDLER_REPORTABLE` subset, so a throw from here
 * keeps its own name instead of being flattened into an execution failure — which is the whole reason
 * the error vocabulary gives the DOM tools two codes of their own rather than none
 * (`docs/reference-error-vocabulary.md#level-2-and-level-3`).
 *
 * **Nothing read from the page is ever in the message.** A refusal names the token and the condition,
 * never a value, a name, or a fragment of the document — nothing read from the page reaches the agent
 * inside a failure (`docs/dom-inspection.md#what-never-reaches-the-agent`).
 */
function requireElement(document: Document, ref: string): Element {
  const outcome = resolveReference(document, ref);
  if (outcome.resolved) return outcome.element;
  const report = REFUSAL_REPORT[outcome.because];
  throw new RuntimeError(report.code, report.message);
}

export interface DomInspectOptions {
  /**
   * The same validator the provider is given.
   *
   * Required, and taken rather than constructed: `src/dom/` holds no validator and reaching for one
   * would put a schema-library dependency inside the Level 2 module — which every build that imports
   * it would then carry.
   */
  readonly validator: SchemaValidator;
}

/**
 * Compiles a schema now, refusing an asynchronous validator by name.
 *
 * `SchemaValidator.compile` may return a promise, and this factory is called where an application
 * builds its element tree — so there is nowhere honest to await. Rather than guessing, an async
 * validator is refused at DECLARATION with a message saying what to do, which is the same place and
 * the same posture as every other declaration-time refusal in this library: an unexpected state fails
 * loud rather than being guessed around.
 */
function compileNow(validator: SchemaValidator, schema: Record<string, unknown>): CompiledSchema {
  const compiled = validator.compile(schema);
  if (compiled instanceof Promise) {
    throw new RuntimeError(
      RUNTIME_FAILURE.schemaNotCompilable,
      'the DOM tools need a validator that compiles synchronously, because they are declared while an application builds its element tree and there is nowhere to await. The bundled validator does.',
    );
  }
  return compiled;
}

/**
 * The Level 2 READ tools, ready to hand to the provider's `builtInTools`.
 *
 * Importing this is one of the two independent conditions that make them reachable; the operator
 * granting `dom.inspect` is the other, and neither implies the other. A build that never calls this
 * contains none of the snapshot code — Level 2 is a separate layer, and Level 1 confers nothing on it.
 */
export function domInspectTools(options: DomInspectOptions): readonly BuiltInTool[] {
  const getTextValidator = compileNow(options.validator, {
    ...GET_TEXT_SCHEMA,
    properties: { ...GET_TEXT_SCHEMA.properties },
    required: [...GET_TEXT_SCHEMA.required],
  });

  return [
    {
      name: 'dom.snapshot',
      level: CONTROL_LEVEL.dom,
      domAuthority: DOM_AUTHORITY.inspect,
      description:
        'Describe what is currently on screen: the page URL and title, and the interactive controls, structure and status messages a person can see, each with a role, an accessible name and a reference token. Returns no page HTML. Prefer an application tool where one exists — this is a fallback for flows that were never instrumented.',
      // No arguments: a root selector would be a query language over the page, and a limit would let
      // the caller raise a bound that exists to protect the page rather than to express a preference.
      handler: () => takeSnapshot(requireDocument()),
    },
    {
      name: 'dom.get_text',
      level: CONTROL_LEVEL.dom,
      domAuthority: DOM_AUTHORITY.inspect,
      description:
        'Read the visible text of one element from the most recent dom.snapshot, by its reference token.',
      inputSchema: GET_TEXT_SCHEMA as unknown as Record<string, unknown>,
      validators: { input: getTextValidator },
      handler: (input) => {
        const document = requireDocument();
        // The schema already guaranteed a string — this reads it, it does not re-check it. Validation
        // happens in the runtime, before the handler, and re-implementing it here is the thing the rule
        // "validate before invoking, in the runtime, never inside the handler" exists to forbid
        // (invariant 4 in `docs/design.md#security-invariants`).
        const element = requireElement(document, input.ref as string);
        return { text: textOf(element) };
      },
    },
  ];
}

/**
 * What each interactability cause tells the agent.
 *
 * Derived from the dictionary rather than spelled at each site — a closed set is declared once — so a
 * new cause is a compile error here instead of a silent fall-through to a default message.
 *
 * **None of these tells the agent to re-snapshot**, and that is the distinction from a stale
 * reference. A stale reference means the page moved on and the agent should look again; this means the
 * agent is looking at the right element and the page will not let it be touched. Re-snapshotting
 * changes nothing, and an agent sent round that loop would hammer a control that will never work.
 */
const NOT_INTERACTABLE_REASON: Readonly<Record<NotInteractable, string>> = {
  [NOT_INTERACTABLE.notPerceivable]: 'that element is not visible on the page',
  [NOT_INTERACTABLE.disabled]: 'that control is disabled',
  [NOT_INTERACTABLE.ariaDisabled]: 'that control reports itself as disabled',
  [NOT_INTERACTABLE.inert]:
    'that element is inside an inert region, which nobody can interact with',
  [NOT_INTERACTABLE.pointerEventsNone]: 'that element does not accept pointer interaction',
  [NOT_INTERACTABLE.readOnly]: 'that field is read-only',
  [NOT_INTERACTABLE.notAField]:
    'that element does not hold a typed value — use dom.select for a dropdown, or dom.click for a control',
  [NOT_INTERACTABLE.noNativeSetter]:
    'that element has no value this library can set in a way the application would receive',
};

/**
 * Throws the refusal the agent will receive, when an element cannot be operated.
 *
 * `MCP_DOM_NOT_INTERACTABLE` is a member of the runtime's `HANDLER_REPORTABLE` subset, so a throw from
 * here keeps its own name rather than being flattened into an execution failure.
 *
 * **Nothing read from the page is in the message** — the cause and nothing else
 * (`docs/dom-inspection.md#what-never-reaches-the-agent`).
 */
function requireOperable(outcome: Interactability): void {
  if (outcome.operable) return;
  throw new RuntimeError(
    RUNTIME_FAILURE.domNotInteractable,
    NOT_INTERACTABLE_REASON[outcome.because],
  );
}

/** The `ref` argument every write tool takes, so the shape is written once. */
const REF_PROPERTY = {
  ref: {
    type: 'string',
    description: 'A reference token from the most recent dom.snapshot, such as "e12".',
  },
} as const;

function writeSchema(
  extra: Record<string, unknown> = {},
  required: string[] = [],
): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
} {
  return {
    type: 'object',
    properties: { ...REF_PROPERTY, ...extra },
    required: ['ref', ...required],
    additionalProperties: false,
  };
}

/**
 * The Level 2 WRITE tools, ready to hand to the provider's `builtInTools`.
 *
 * A SECOND factory beside `domInspectTools`, deliberately: an application that wants an agent able to
 * describe its pages and not to touch them supplies only the first. That is the profile the
 * documentation leads with, and a single factory returning all seven would have made the recommended
 * shape unavailable.
 *
 * **No tool here declares `permissions`, and that is a decision rather than an omission.** A
 * `confirmation: 'required'` on `dom.click` would put a person in front of every click of a multi-step
 * flow — not a safety boundary but a rate limit, and one that trains people to click through, which is
 * the failure the confirmation surface itself warns about. The CAPABILITY is the decision point:
 * `dom.interact` is granted per connection by an operator, and refusing it is total.
 */
export function domInteractTools(options: DomInspectOptions): readonly BuiltInTool[] {
  const compile = (schema: Record<string, unknown>): CompiledSchema =>
    compileNow(options.validator, schema);

  const clickSchema = writeSchema();
  const fillSchema = writeSchema(
    { value: { type: 'string', description: 'The text to put in the field.' } },
    ['value'],
  );
  const selectSchema = writeSchema(
    {
      option: {
        type: 'string',
        description: 'The option to choose, by the label dom.snapshot reported for it.',
      },
    },
    ['option'],
  );
  const pressSchema = writeSchema(
    { key: { type: 'string', enum: [...PRESSABLE_KEY_VALUES], description: 'The key to press.' } },
    ['key'],
  );
  const scrollSchema = writeSchema(
    {
      direction: {
        type: 'string',
        enum: [...SCROLL_DIRECTION_VALUES],
        description: 'Where to scroll the element, or its nearest scrollable ancestor.',
      },
    },
    ['direction'],
  );

  /** Every write tool shares this shape, so a sixth cannot be added past the gate or the barrier. */
  const write = (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    act: (element: Element, input: Record<string, unknown>) => unknown,
  ): BuiltInTool => ({
    name,
    level: CONTROL_LEVEL.dom,
    domAuthority: DOM_AUTHORITY.interact,
    description,
    inputSchema: schema,
    validators: { input: compile(schema) },
    handler: async (input, context) => {
      const document = requireDocument();
      const element = requireElement(document, input.ref as string);
      const applied = act(element, input);
      // **Resolve only once the application has committed**
      // (`docs/design.md#a-call-settles-after-the-commit`). A write that returned after dispatching
      // would report success before React had processed the event — and a real socket's round trip
      // gives React enough time to hide that, which is why the cases assert AGREEMENT between what
      // this reports and what the page shows rather than the outcome alone.
      await context.afterRender();
      return applied;
    },
  });

  return [
    write(
      'dom.click',
      'Click one element from the most recent dom.snapshot. Prefer an application tool where one exists — this is a fallback for flows that were never instrumented.',
      clickSchema,
      (element, input) => {
        requireOperable(interactabilityOf(element));
        (element as HTMLElement).click();
        return { clicked: input.ref };
      },
    ),
    write(
      'dom.fill',
      'Put text into one field from the most recent dom.snapshot. The change travels through the application’s own handlers.',
      fillSchema,
      (element, input) => {
        requireOperable(fillabilityOf(element));
        requireOperable(applyFill(element, input.value as string));
        return { filled: input.ref, value: input.value };
      },
    ),
    write(
      'dom.select',
      'Choose an option in one dropdown, by the label dom.snapshot reported for it.',
      selectSchema,
      (element, input) => {
        requireOperable(interactabilityOf(element));
        requireOperable(applySelect(element, input.option as string));
        return { selected: input.ref, option: input.option };
      },
    ),
    write(
      'dom.press',
      'Press one key at an element — Enter, Escape, Tab, Backspace, Delete or an arrow. Not a typing surface; use dom.fill for text.',
      pressSchema,
      (element, input) => {
        requireOperable(interactabilityOf(element));
        applyPress(element, input.key as string);
        return { pressed: input.ref, key: input.key };
      },
    ),
    write(
      'dom.scroll',
      'Scroll one element, or its nearest scrollable ancestor, in a direction. Reports where it ended up.',
      scrollSchema,
      (element, input) => {
        requireOperable(interactabilityOf(element));
        const direction = input.direction as string;
        // The schema already bounded this; the guard is what keeps the CAST honest rather than a
        // second validation (a received string is validated at the boundary, never `as`-cast onto a type
        // that does not admit it).
        if (!isScrollDirection(direction)) {
          throw new RuntimeError(
            RUNTIME_FAILURE.argumentsInvalid,
            'that is not a direction dom.scroll accepts',
          );
        }
        return { scrolled: input.ref, ...applyScroll(element, direction as ScrollDirection) };
      },
    ),
  ];
}
