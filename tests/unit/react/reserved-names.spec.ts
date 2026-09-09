// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRegistrationGateway } from '../../../src/react/registration.ts';
import {
  createOwnershipRecord,
  RUNTIME_FAILURE,
  type ToolHandler,
} from '../../../src/runtime/index.ts';
import type { SchemaValidator } from '../../../src/runtime/validation.ts';
import { REGISTRATION_REFUSED } from '../../../src/webmcp/index.ts';
import { ensureRegistry, register, resetResolutionForTests } from '../../../src/webmcp/registry.ts';

// The reserved prefixes, at the one place an application can reach the document's shared registry.
//
// **Why the gate is here and not at invocation**, which is where every other gate in this feature
// lives: by the time a call arrives the name is already TAKEN, in a registry shared with every script
// on the page. There is nothing left to refuse. A reserved name has to be refused at declaration or
// not at all.
//
// **What the rule protects, stated as reachability rather than tidiness.** `dom.` and `runtime.` are
// where Level 2 and Level 3 built-ins live, and a tool's level comes from the table it was found in.
// An application registration under `dom.click` is therefore a Level 1 tool wearing a Level 2 name: an
// agent granted `application` and denied `dom` lists it, calls it, and passes the capability gate,
// because the gate reads the level of the table the tool came from and that table is the
// application's. Nothing downstream can recover the distinction.
//
// These cases drive the gateway directly rather than through a renderer, for the reason the
// neighbouring registration suite gives: the guarantees here are about ORDER, and a renderer decides
// the order for you. Two of them — refusing before the provider opens, and refusing before a schema is
// compiled — are not observable any other way.
//
// **What the break-it run established, including the part that reads as redundancy and is not.**
// Deleting the check from `enqueue` reddens seven; refusing a rename without aborting the previous
// registration reddens the two rename cases and nothing else; deleting the check from `replace` alone
// reddens the same two. The interesting one is `startsWith` → `includes`, which reddens exactly ONE
// case: `editor.dom.describe`. `domain.set_filters` does not catch it, because `domain.` does not
// contain `dom.` — the dot is what saves it. The two namespace cases therefore guard different
// mistakes: one catches a check written against `dom` without the separator, the other catches a
// prefix test written as a substring test. Neither is a spare copy of the other.

beforeEach(() => {
  resetResolutionForTests();
  Reflect.deleteProperty(document as object, 'modelContext');
  Reflect.deleteProperty(navigator as object, 'modelContext');
  Reflect.deleteProperty(globalThis as object, '__webMCPPolyfillOptions');
  Object.defineProperty(globalThis, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  resetResolutionForTests();
  Reflect.deleteProperty(document as object, 'modelContext');
  Reflect.deleteProperty(navigator as object, 'modelContext');
  Reflect.deleteProperty(globalThis as object, '__webMCPPolyfillOptions');
});

const handler: ToolHandler = () => ({ ok: true });

function request(name: string, controller: AbortController, inputSchema?: Record<string, unknown>) {
  return {
    declaration: {
      name,
      description: `the ${name} tool`,
      ...(inputSchema === undefined ? {} : { inputSchema }),
      handler: () => ({ ok: true }),
    },
    handler,
    controller,
  };
}

async function registeredNames(): Promise<string[]> {
  const { registry } = await ensureRegistry();
  return (await registry.getTools()).map((tool) => tool.name);
}

/** The code on a refusal, or what it actually was — so a wrong failure names itself in the diff. */
function codeOf(cause: unknown): unknown {
  return (cause as { code?: unknown }).code ?? cause;
}

/**
 * A validator that refuses everything it is asked to compile.
 *
 * Stands in for the two ways a schema goes wrong at declaration — an uncompilable schema, and a
 * schema with no validator installed. Which one it is does not matter to these cases; what matters is
 * that compilation is a step that can fail, so a run that reached it reports ITS failure rather than
 * the reserved name.
 */
const refusingValidator: SchemaValidator = {
  compile: () => {
    throw new Error('this validator compiles nothing');
  },
};

describe('a declaration using a reserved prefix', () => {
  it('is refused, and nothing is registered under the name', async () => {
    const gateway = createRegistrationGateway();
    gateway.open(createOwnershipRecord());

    await expect(
      gateway.enqueue(request('dom.click', new AbortController())),
    ).rejects.toMatchObject({ code: REGISTRATION_REFUSED.nameReserved });

    expect(await registeredNames()).not.toContain('dom.click');
  });

  it('is refused for every reserved prefix, not only the first one in the dictionary', async () => {
    // `runtime.` is the Level 3 namespace, and Level 3 is the one whose blast radius is the whole
    // page. A check that matched only `dom.` would pass every other case in this file.
    const gateway = createRegistrationGateway();
    gateway.open(createOwnershipRecord());

    await expect(
      gateway.enqueue(request('runtime.evaluate', new AbortController())),
    ).rejects.toMatchObject({ code: REGISTRATION_REFUSED.nameReserved });

    expect(await registeredNames()).not.toContain('runtime.evaluate');
  });

  it('names the prefix and the tool, and offers the fix', async () => {
    // The refusal is read by an AUTHOR, not an agent — nothing here came from a connection, so there
    // is no received value to redact and the name is exactly what has to be said.
    const gateway = createRegistrationGateway();
    gateway.open(createOwnershipRecord());

    const refusal = await gateway
      .enqueue(request('dom.click', new AbortController()))
      .catch((cause: unknown) => cause);

    expect((refusal as Error).message).toContain('dom.click');
    expect((refusal as Error).message).toContain('dom.');
    expect((refusal as Error).message).toContain('runtime.');
  });
});

describe('a prefix is a namespace, not a substring', () => {
  it('registers `domain.set_filters`, which was never reserved', async () => {
    // The pairing that makes every refusal above mean something. Without it a gateway that refused
    // every name containing "dom" satisfies this whole file — and it would have taken an ordinary
    // business namespace away from every application that has one.
    const gateway = createRegistrationGateway();
    gateway.open(createOwnershipRecord());

    await gateway.enqueue(request('domain.set_filters', new AbortController()));

    expect(await registeredNames()).toContain('domain.set_filters');
  });

  it('registers a name that merely CONTAINS a reserved prefix later on', async () => {
    const gateway = createRegistrationGateway();
    gateway.open(createOwnershipRecord());

    await gateway.enqueue(request('editor.dom.describe', new AbortController()));

    expect(await registeredNames()).toContain('editor.dom.describe');
  });
});

describe('the classification is synchronous and FIRST', () => {
  it('refuses before the provider has opened, so it needs nothing to be ready', async () => {
    // The gateway is never opened. Every other refusal in this module is downstream of `availability()`
    // and could not arrive at all — which is what makes this the case that pins "synchronous".
    const gateway = createRegistrationGateway();

    await expect(
      gateway.enqueue(request('dom.click', new AbortController())),
    ).rejects.toMatchObject({ code: REGISTRATION_REFUSED.nameReserved });
  });

  it('refuses before a schema is compiled, on the first registration', async () => {
    const gateway = createRegistrationGateway();
    gateway.open(createOwnershipRecord(), refusingValidator);

    const refusal = await gateway
      .enqueue(request('dom.click', new AbortController(), { type: 'object' }))
      .catch((cause: unknown) => cause);

    expect(codeOf(refusal)).toBe(REGISTRATION_REFUSED.nameReserved);
    expect(codeOf(refusal)).not.toBe(RUNTIME_FAILURE.schemaNotCompilable);
  });

  it('refuses before the registry classifies the name as held by a foreign script', async () => {
    // A page script has already taken `dom.click`. Without the ordering the author is told a foreign
    // owner holds the name — true, and not their problem: renaming is the fix either way, and only
    // one of the two messages says so.
    const { registry } = await ensureRegistry();
    const foreign = new AbortController();
    await registry.registerTool(
      {
        name: 'dom.click',
        description: 'registered by somebody else',
        inputSchema: { type: 'object', properties: {} },
        execute: () => ({ content: [{ type: 'text', text: 'from a foreign script' }] }),
      },
      { signal: foreign.signal },
    );

    const gateway = createRegistrationGateway();
    gateway.open(createOwnershipRecord());

    const refusal = await gateway
      .enqueue(request('dom.click', new AbortController()))
      .catch((cause: unknown) => cause);

    expect(codeOf(refusal)).toBe(REGISTRATION_REFUSED.nameReserved);
    foreign.abort();
  });

  it('refuses before the registry classifies the name as this application colliding with itself', async () => {
    const ownership = createOwnershipRecord();
    const gateway = createRegistrationGateway();
    gateway.open(ownership);

    // Nothing reserved about this one — it establishes that the collision path is live, so the case
    // below is about the ORDER rather than about a name that could never have collided.
    const held = new AbortController();
    await register(
      { name: 'dom.click', description: 'held by us', handler: () => ({ ok: true }) },
      held.signal,
      ownership,
    );

    const refusal = await gateway
      .enqueue(request('dom.click', new AbortController()))
      .catch((cause: unknown) => cause);

    expect(codeOf(refusal)).toBe(REGISTRATION_REFUSED.nameReserved);
    held.abort();
  });

  it('still reports a schema failure when the name is fine, which is what the ordering cases assume', async () => {
    // The pairing. A gateway that reported `nameReserved` for everything satisfies all four cases
    // above, and would have deleted the declaration-time schema check.
    const gateway = createRegistrationGateway();
    gateway.open(createOwnershipRecord(), refusingValidator);

    const refusal = await gateway
      .enqueue(request('panel.click', new AbortController(), { type: 'object' }))
      .catch((cause: unknown) => cause);

    expect(codeOf(refusal)).toBe(RUNTIME_FAILURE.schemaNotCompilable);
  });
});

describe('a rename INTO a reserved name', () => {
  it('withdraws the registration that was standing', async () => {
    // A leak that shipped once, arriving by a new route. The hook has already moved its controller
    // ref to the registration being CREATED, so if the refusal does not abort the previous controller
    // nothing reachable ever will: the old tool keeps the name for the life of the page, with a handler
    // no mounted component declares.
    const ownership = createOwnershipRecord();
    const gateway = createRegistrationGateway();
    gateway.open(ownership);

    const first = new AbortController();
    const declared = request('panel.click', first);
    await gateway.enqueue(declared);
    expect(await registeredNames()).toContain('panel.click');

    const second = new AbortController();
    await expect(
      gateway.replace({
        ...request('dom.click', second),
        previous: declared.declaration,
        previousController: first,
      }),
    ).rejects.toMatchObject({ code: REGISTRATION_REFUSED.nameReserved });

    expect(await registeredNames()).not.toContain('panel.click');
    expect(await registeredNames()).not.toContain('dom.click');
    // The ownership record follows the registry off the same abort, so the runtime is not left
    // reporting a divergence about a tool nobody touched.
    expect(ownership.holds('panel.click')).toBe(false);
  });

  it('reports the reserved name even when the same render also changed a schema', async () => {
    // The reason the refusal is specified as happening FIRST rather than "somewhere before the registry".
    // Compilation is the step immediately downstream, and it fails LOUDLY — so an ordering mistake
    // here does not go unnoticed, it sends the author to fix a schema that is not the problem.
    const ownership = createOwnershipRecord();
    const gateway = createRegistrationGateway();
    gateway.open(ownership, refusingValidator);

    const first = new AbortController();
    const declared = request('panel.click', first);
    await gateway.enqueue(declared);

    const second = new AbortController();
    const refusal = await gateway
      .replace({
        ...request('dom.click', second, { type: 'object' }),
        previous: declared.declaration,
        previousController: first,
      })
      .catch((cause: unknown) => cause);

    expect(codeOf(refusal)).toBe(REGISTRATION_REFUSED.nameReserved);
    expect(codeOf(refusal)).not.toBe(RUNTIME_FAILURE.schemaNotCompilable);
    expect(await registeredNames()).not.toContain('panel.click');
  });
});

describe('a rename OUT of a reserved name', () => {
  it('registers the new name, because the refusal withdrew nothing that existed', async () => {
    // The other direction, and it is not symmetric: the reserved registration never happened, so the
    // replacement has nothing to withdraw and must still register. A guard that treated the previous
    // declaration as live would leave the author with a component that can never register anything
    // again after one bad name.
    const ownership = createOwnershipRecord();
    const gateway = createRegistrationGateway();
    gateway.open(ownership);

    const first = new AbortController();
    const bad = request('dom.click', first);
    await gateway.enqueue(bad).catch(() => undefined);

    const second = new AbortController();
    await gateway.replace({
      ...request('panel.click', second),
      previous: bad.declaration,
      previousController: first,
    });

    expect(await registeredNames()).toContain('panel.click');
  });
});
