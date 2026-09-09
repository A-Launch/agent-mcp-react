import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The manifest and the tree, asserted to agree.
//
// `package.json`'s `exports` map is the package's public surface
// (`docs/design.md#package-structure`). An entry pointing at a file that does not exist fails at an
// embedder's install, not here — the kind of hidden broken state that must fail loud here instead,
// and one that a repository with no implementation yet is unusually good at producing. This case is cheap and it fails at the moment the divergence is introduced.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Manifest {
  readonly name: string;
  readonly type?: string;
  readonly exports: Record<string, string>;
  readonly scripts: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

async function readManifest(relativePath: string): Promise<Manifest> {
  return JSON.parse(await readFile(resolve(repoRoot, relativePath), 'utf8')) as Manifest;
}

/** Every shipped source file: the library itself, excluding colocated cases. */
async function libraryFiles(): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(resolve(repoRoot, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)) found.push(path);
    }
  }

  await walk('src');
  return found;
}

/**
 * The package names a file imports at RUNTIME, keyed by the line they appear on.
 *
 * Type-only imports are excluded deliberately: they are erased at build, so a type from a
 * devDependency ships nothing and forcing it into `dependencies` would make every consumer install a
 * package they never execute. Everything else counts, including a dynamic `import()` — which is how
 * the registry boundary reaches the portability layer, and would otherwise be the one runtime import
 * this check could not see.
 */
function runtimeImports(source: string): Map<string, number> {
  const found = new Map<string, number>();

  for (const [index, text] of source.split('\n').entries()) {
    if (/^\s*(import|export)\s+type\s/.test(text)) continue;
    // A line inside a comment is not an import. This is not a nicety: the modules here document their
    // own usage, and a doc comment showing `import { createAjvValidator } from 'agent-mcp-react/validation'`
    // is exactly the example an author needs — while looking, to a line scanner, like the library
    // importing itself. Reported as a missing dependency, which it is not.
    //
    // Line-prefix detection rather than a comment parser: everything in this repository writes block
    // comments with a leading `*`, so this covers the real cases without pretending to understand
    // JavaScript. A specifier inside a template literal would still be missed, and that is stated
    // rather than silently assumed away.
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;

    for (const pattern of [
      /(?:^|\s)(?:import|export)\s[^'"]*from\s*['"]([^'"]+)['"]/,
      /\bimport\(\s*['"]([^'"]+)['"]\s*\)/,
    ]) {
      const specifier = pattern.exec(text)?.[1];
      if (specifier === undefined) continue;
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
      if (specifier.startsWith('node:')) continue;

      // `@scope/name/subpath` and `name/subpath` both resolve to the package, not the subpath.
      const segments = specifier.split('/');
      const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
      if (name !== undefined && !found.has(name)) found.set(name, index + 1);
    }
  }

  return found;
}

describe('the package surface', () => {
  it('points every subpath export at a file that exists', async () => {
    const manifest = await readManifest('package.json');
    const entries = Object.entries(manifest.exports);

    expect(entries.length).toBeGreaterThan(0);
    for (const [subpath, target] of entries) {
      expect(existsSync(resolve(repoRoot, target)), `${subpath} → ${target}`).toBe(true);
    }
  });

  it('offers the inspector at its own subpath, so a build that never imports it never carries it', async () => {
    const manifest = await readManifest('package.json');

    // Not covered by the loop above, which only says every DECLARED subpath resolves. This says the
    // subpath is declared at all — and that is the whole delivery mechanism for a development panel:
    // the provider does not import `src/devtools/`, so nothing pulls it into an application's bundle
    // but an explicit import of this entry point.
    expect(manifest.exports['./devtools']).toBe('./src/devtools/index.ts');
  });

  it('declares every script the health gate names', async () => {
    const manifest = await readManifest('package.json');

    // These four are the gate that runs after any change under `src/`, `examples/` or `tools/`
    // (`CONTRIBUTING.md#3-the-gate`). A gate whose commands do not exist is not a gate.
    for (const script of ['test', 'typecheck', 'lint', 'test:transport']) {
      expect(manifest.scripts[script], script).toBeTypeOf('string');
    }
  });

  it('gives the mock agent no script name that pnpm shadows with a built-in', async () => {
    const manifest = await readManifest('tools/mock-agent/package.json');

    // `pnpm list` runs pnpm's own dependency listing rather than the script, prints a tree and exits
    // 0 — a script that appears to work and never ran. The other names here shadow the same way.
    // This is the class of mistake, not one instance: any new script must clear the same set, which
    // is why the check is a list rather than a note about `list`.
    const shadowed = ['list', 'add', 'remove', 'update', 'why', 'outdated', 'link', 'install'];
    for (const name of Object.keys(manifest.scripts)) {
      expect(shadowed, `script "${name}" is shadowed by a pnpm built-in`).not.toContain(name);
    }
  });

  it('declares every package src/ imports at runtime as a real dependency', async () => {
    const manifest = await readManifest('package.json');
    // A **peer** dependency counts. It is a declared runtime dependency that the consumer supplies
    // rather than one this package installs, which is exactly the right arrangement for a renderer:
    // putting React in `dependencies` would let an application end up running two copies, and two
    // copies of React is two sets of hooks, two contexts, and a provider a hook cannot see.
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const devDependencies = new Set(Object.keys(manifest.devDependencies ?? {}));
    const misclassified: string[] = [];

    for (const path of await libraryFiles()) {
      const source = await readFile(resolve(repoRoot, path), 'utf8');
      for (const [name, line] of runtimeImports(source)) {
        if (declared.has(name)) continue;
        misclassified.push(
          `${path}:${line} — ${name} is ${
            devDependencies.has(name) ? 'a devDependency' : 'not declared at all'
          }`,
        );
      }
    }

    // The one failure this catches is invisible until someone installs the published package: a
    // devDependency is not installed for a consumer, so the import resolves here, resolves in CI, and
    // throws at first use in their application. Nothing in the build says so, so this case is what
    // makes the unknown loud.
    expect(
      misclassified,
      `these are imported at runtime by src/ but are not in "dependencies":\n${misclassified.join('\n')}`,
    ).toEqual([]);
  });

  it('is ESM throughout — the library and every workspace package', async () => {
    // "ESM only, no CommonJS anywhere" is a module rule, and the manifest is where it is either true
    // or quietly not.
    for (const path of ['package.json', 'tools/mock-agent/package.json']) {
      const manifest = await readManifest(path);
      expect(manifest.type, path).toBe('module');
    }
  });
});

describe('the public React surface', () => {
  // The export map fixes what an application can import. The count is the assertion, so a further thing that
  // an application CALLS fails here rather than being noticed in review — and, once shipped, being
  // impossible to take back without a breaking change.

  it('offers exactly six things an application calls, and names everything else it ships', async () => {
    const surface = await import('../../src/index.ts');

    // The whole export list, not a subset. A subset assertion grows a surface one convenience at a
    // time, and a published export cannot be taken back without a breaking change.
    expect(Object.keys(surface).sort()).toEqual(
      [
        // The six an application calls.
        'AgentMcpProvider',
        'useMcpCapabilities',
        'useMcpConnection',
        // The read half of the control interface: mutation tools alone are insufficient, because an
        // agent that cannot read back what it changed is working blind
        // (`docs/exposing-state.md`), and this hook is mandatory for the first release. It publishes `<name>.get_state` as an
        // ORDINARY Level 1 registration, so it adds a surface to the API and none to the gate model.
        'useMcpState',
        // The one hook that needs no provider above it: a page instance's identity is a
        // fact about the page, not about a connection.
        'useMcpTabId',
        'useMcpTool',
        // The vocabularies a caller matches against, and their predicates. A closed set of literals
        // is declared once as an exported dictionary with its type derived from it, so a caller never
        // spells a member as a string.
        'CLAIM_REFUSED',
        'CONNECTION_STATUS',
        'CONNECTION_TRANSITIONS',
        'REACT_REFUSED',
        'REGISTRATION_REFUSED',
        'REGISTRY_UNAVAILABLE',
        // An application catches a failed identity mint — a server render, or a page
        // outside a secure context — and branches on which of the two it was, so the error type, its
        // dictionary and its predicate all have to be importable.
        'IDENTITY_UNAVAILABLE',
        'PageIdentityError',
        'isIdentityUnavailableCode',
        // A caller branches on a validation verdict, so the dictionary has to be importable — an
        // application forced to spell 'invalid' as a string literal is an application hardcoding a
        // member of a closed set.
        //
        // The VALIDATOR itself is deliberately NOT here: it lives at the ./validation subpath, because
        // it is 54 KB gzipped and an application whose tools declare no schemas should not carry it.
        'VALIDATION',
        // The runtime's failure vocabulary reaches an application twice: through `onUnexpectedState`,
        // and as the code on a tool error — including the two cancellation causes, which are exactly
        // the sort of thing a caller branches on.
        'RUNTIME_FAILURE',
        // An application WRITES the capability set and reads back a control level or a DOM authority
        // in a refusal, so both dictionaries and their predicates have to be importable — otherwise
        // the one prop this library requires can only be written as string literals, which is exactly
        // the hardcoded closed-set member the dictionaries exist to prevent.
        //
        // What is NOT here is the point: `admitsLevel`, `admitsAvailability` and `needsConfirmation`
        // stay inside the package. They are the gate's own decisions, and an application holding them
        // would be reasoning about admission somewhere other than where it is enforced. `src/security/`
        // gets no subpath export either.
        'CAPABILITY_MEMBER',
        'CONTROL_LEVEL',
        'DOM_AUTHORITY',
        'RISK',
        'isCapabilityMember',
        'isDomAuthority',
        'isRisk',
        // The confirmation decision set and its predicate. An application writes a resolver that must
        // RETURN a member of this set, so it is the one closed vocabulary a caller produces rather
        // than merely branches on — and one it could not write at all without importing.
        'CONFIRMATION',
        'isConfirmationDecision',
        'isConnectionStatus',
        'isReactRefusedCode',
        'isRuntimeFailureCode',
        // The one error type this module raises itself.
        'AgentMcpReactError',
        // An application receives observability events and branches on every one of these:
        // which phase the record describes, which route the call arrived by, what each gate step did,
        // which vocabulary a failure code came from, and which resolution refused. Without them the
        // events could only be read by spelling members of five closed sets as string literals.
        //
        // `OBSERVED_PAYLOADS` is the one an application WRITES rather than reads — it is the value of
        // the `observability` prop, and the reason it must be importable is the same reason the
        // capability dictionaries are.
        'CALL_PHASE',
        'CALL_ROUTE',
        'FAILURE_VOCABULARY',
        'GATE_OUTCOME',
        'OBSERVED_PAYLOADS',
        'isCallPhase',
        'isCallRoute',
        'isFailureVocabulary',
        'isGateOutcome',
        'isObservedPayloads',
        'isResolutionRefusal',
        // The suffix a state surface's agent-visible tool name is built from. Exported for the reason
        // every dictionary here is: a caller that cannot import it is one forced to spell `get_state`
        // as a literal, and a literal cannot be checked against the thing it came from. The acceptance
        // scenario names `customers.get_state` verbatim
        // (`docs/design.md#the-acceptance-scenario`), so this is where that requirement is honoured
        // once.
        //
        // **`stateToolName` is deliberately NOT here**, although it exists and the module exports it
        // for its own cases. Nothing in this release needs an application to compute a state tool's
        // name, and this package exports a thing when a feature has a use for it rather than because
        // it exists — the same rule that keeps `useMcpRuntime` internal. A published export cannot be
        // taken back without a breaking change; an unpublished one costs nothing to add later.
        'STATE_TOOL_SUFFIX',
        // What is NOT here, and the reason it is the point: `createObservationBus`, the projector and
        // the call counter stay inside the package. An application that could construct or emit a
        // record could fabricate evidence about a call that never happened — and an observability
        // surface whose records cannot be trusted is worse than none, because it is believed.
      ].sort(),
    );
  });

  it('hands out no path to the runtime, the registry boundary or the transport', async () => {
    const surface = (await import('../../src/index.ts')) as Record<string, unknown>;

    // The runtime carries the ownership record every gate is built on. A public path to it is a public
    // path AROUND them — which is why this is asserted by name rather than left to the count above.
    for (const forbidden of [
      'useMcpRuntime',
      'createMcpRuntime',
      'createRegistrationGateway',
      'createBrowserWebSocketTransport',
      'ensureRegistry',
      'register',
      'enumerate',
      'claimDocument',
      // `src/security/` stays internal: it gets no subpath export and its
      // decisions are not re-exported here. A caller holding `admitsLevel` would be reasoning about
      // admission somewhere other than where it is enforced, and one holding `normalizeCapabilities`
      // could build a capability set the provider never checked.
      'admitsLevel',
      'admitsAvailability',
      'needsConfirmation',
      'normalizeCapabilities',
      'capabilitySignature',
      'DENIES_EVERYTHING',
      // The reserved prefixes are enforced at declaration and named in the refusal's message. An
      // application branching on WHICH prefix it hit is not a use case, and exporting the dictionary
      // would invite one — the code on the refusal is what a caller matches against.
      'RESERVED_PREFIX',
      'reservedPrefixOf',
    ]) {
      expect(surface[forbidden], `${forbidden} must not be public surface`).toBeUndefined();
    }
  });

  it('exports the vocabularies a caller has to match against', async () => {
    const surface = await import('../../src/index.ts');

    // Not a widening of the rule above. A caller must never spell a code as a string literal, so a
    // vocabulary an application cannot import is a vocabulary it is forced to hardcode.
    expect(Object.keys(surface.CONNECTION_STATUS).sort()).toEqual([
      'connected',
      'connecting',
      'disconnected',
      'error',
      'reconnecting',
    ]);
    expect(surface.REACT_REFUSED.providerMissing).toBe('MCP_REACT_PROVIDER_MISSING');
    expect(surface.CLAIM_REFUSED.providerAlreadyActive).toBe('MCP_REACT_PROVIDER_ALREADY_ACTIVE');
    expect(surface.REGISTRATION_REFUSED.registrationWithdrawn).toBe(
      'MCP_TOOL_REGISTRATION_WITHDRAWN',
    );
  });

  it('offers no connection state nothing can reach', async () => {
    const surface = await import('../../src/index.ts');

    // **The rule, asserted directly rather than as one member's absence.** This used to assert that
    // `reconnecting` was absent, which was the true property of a build that could not reach it. It is
    // no longer, so the case says what the rule always meant: a state nothing can produce is a state a
    // reader has to disprove, so every member must be reachable from where a provider starts.
    //
    // Written as a walk rather than a list, because a list would have to be edited by whoever adds the
    // next member — and the edit that keeps a case passing is the edit that stops it testing.
    const reachable = new Set<string>([surface.CONNECTION_STATUS.disconnected]);
    for (let pass = 0; pass < Object.keys(surface.CONNECTION_STATUS).length; pass += 1) {
      for (const [from, targets] of Object.entries(surface.CONNECTION_TRANSITIONS)) {
        if (!reachable.has(from)) continue;
        for (const to of targets) reachable.add(to);
      }
    }

    expect([...reachable].sort()).toEqual(Object.values(surface.CONNECTION_STATUS).sort());
  });
});
