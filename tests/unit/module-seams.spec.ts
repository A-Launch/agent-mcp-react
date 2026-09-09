import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The module seams, enforced rather than asserted.
//
// This library rests on two rules of the same shape: a platform surface may be named in exactly one
// directory, and nowhere else. The tool registry belongs to `src/webmcp/`; the socket belongs to
// `src/transport/`. Both are rules a person can follow for a year and then break in one line while
// fixing something else — which is why they are cases in the health gate and not paragraphs in a
// document.
//
// **One mechanism, one row per seam.** The registry seam arrived first and this file was written
// around it; the socket seam is the same shape, so it is a row rather than a second file. Two copies
// would drift, and the drift would show up as one seam silently unchecked. Fix the mechanism that
// produces a class of errors rather than one occurrence, and keep one owner per truth.
//
// This is also the one file here that fails for a reason nobody was working on, so its failures name
// the offending file, line and rule. A message saying only "expected 0 to be 1" would cost the reader
// the ten minutes these cases exist to save them.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * A platform surface, and the one directory permitted to name it.
 *
 * Adding a seam is one row. The `why` is carried here rather than in a comment beside the pattern
 * because it is what the failure message shows, and a reader who has just broken a rule they have
 * never read needs the reason more than the rule.
 *
 * `scope` names the roots a row applies to, and defaults to all of them. Most rows are about a
 * PLATFORM surface and bind everything in the repository — an example that reached the tool registry
 * directly would be demonstrating something no embedder can do. The React row is different in kind:
 * it is a layering rule inside the library, and an example application is a React application by
 * definition. Scoping it is what keeps the row meaningful rather than making it fire on the one thing
 * it was never about.
 */
const SEAMS: ReadonlyArray<{
  subject: string;
  owner: string;
  scope?: readonly string[];
  pattern: RegExp;
  /**
   * Occurrences removed from a line BEFORE the pattern is tested.
   *
   * For a seam whose pattern necessarily matches more than the thing it protects. The build-flag row
   * is the only one that needs it: its pattern is `import.meta.env`, and that expression is also how
   * a Vite application reads its OWN configuration — which is not the development-versus-production
   * flag and is not what the row exists to keep to one owner.
   *
   * Narrowing the pattern instead would have been worse: `import.meta.env.DEV` alone misses
   * `const { DEV } = import.meta.env` and `import.meta.env['DEV']`, so a genuine second reader could
   * walk straight past it. Subtracting the one shape that is definitely not the flag keeps every
   * other shape caught.
   */
  allow?: RegExp;
  why: string;
}> = [
  {
    subject: 'the platform tool registry',
    owner: join('src', 'webmcp'),
    pattern: /\b(document|navigator)\s*\.\s*modelContext\b/,
    why: 'the standard is a moving draft whose host object has already migrated once; a revision must be absorbable in one directory',
  },
  {
    subject: 'a WebSocket',
    owner: join('src', 'transport'),
    pattern: /\bnew\s+WebSocket\b|\bglobalThis\s*\.\s*WebSocket\b/,
    why: 'the transport is the one place a real socket is exercised by the suite; a socket reference elsewhere is a code path that suite does not cover',
  },
  {
    subject: 'React',
    owner: join('src', 'react'),
    scope: ['src'],
    pattern: /from\s+['"]react(\/|['"])/,
    why: 'the runtime, the boundary, the transport and the security layer are framework-free, which is what lets them be tested without a renderer and what keeps a future non-React binding a sibling directory rather than a rewrite',
  },
  {
    // The owner here is a single FILE rather than a directory, which the containment check handles
    // unchanged. The distinction belongs to no concern directory: three of them need it.
    subject: 'the build-mode flag',
    owner: join('src', 'build-mode.ts'),
    pattern: /\bNODE_ENV\b|\bimport\s*\.\s*meta\s*\.\s*env\b/,
    // An application's own `AMR_`-prefixed configuration. Reading it is not reading the build flag,
    // and the example app has to read something: a documented knob nothing consults is the hidden
    // unknown that must fail loud rather than sit unreported, which is exactly what `.env.example`
    // had become.
    allow: /\bimport\s*\.\s*meta\s*\.\s*env\s*\.\s*AMR_[A-Z0-9_]+/g,
    why: 'three directories need development-versus-production and none owns it; three readings of one condition is three chances to invert a comparison, and the inverted one ships stack traces to an agent while the other two keep looking correct',
  },
  {
    // A single FILE again, and for the same reason: a page instance's identity belongs to no concern
    // directory. The React binding publishes it; it does not own it.
    subject: "the platform's unique-value source",
    owner: join('src', 'page-identity.ts'),
    pattern: /\brandomUUID\b/,
    why: 'a second site that mints a page identity is a second chance to add a fallback when the source is missing, and a fallback here cannot be told from success — two page instances that share an identity look like one page, so an agent addresses one and reaches the other while every result looks normal',
  },
  {
    // **The one row that is not about a platform surface**, and it is here rather than in a file of
    // its own because it is the same mechanism: a thing that may be named in exactly one directory.
    //
    // The direction matters. The published import rule runs the other way
    // (`CONTRIBUTING.md#4-where-code-goes`): an example or a tool consumes the package's public entry
    // points only, and MUST NOT deep-import `src/`, because an example reaching around the public
    // entry points proves something no embedder could rely on. Whether a TEST may import an example
    // is the question this row answers, and the answer is: exactly one suite may, and it is the one
    // whose entire purpose is to drive the demonstrator.
    subject: 'the example applications',
    owner: join('tests', 'integration'),
    scope: ['tests'],
    // Matches the SPECIFIER rather than one import syntax, because `from` is only one of the four
    // ways in. An adversarial review found this row green against the very form the integration
    // harness itself uses: a side-effect import, which names the module and has no `from` at all. A
    // dynamic import and a relative reach up into the examples directory were the other two. A seam
    // that catches one spelling of the thing it forbids is a seam that reports success, which is a
    // hidden unknown rather than a pass.
    //
    // **This row scans the file it is declared in**, so the specifier is described here and never
    // written between quotes — spelled out, the row would match its own comment. Found by running it,
    // which is also how the step-14 seam case in the acceptance suite learned the same lesson.
    pattern: /['"](?:@agent-mcp\/example-|(?:\.\.\/)+examples\/)/,
    why: 'the integration layer exists to drive the demonstrator and is defined by doing so; every other suite must fail or pass on the library alone, because a library whose unit or React cases imported its own demonstrator would be one whose tests pass because of the demonstrator — and the demonstrator is the thing those tests are supposed to be independent evidence about',
  },
  {
    // **The row that keeps a tree-shaking claim from being a hope.** Level 2 has its own subpath
    // export so a build that never asks for it never contains it — the three levels of control are
    // separate layers, and Levels 2 and 3 never enter the shared registry
    // (`docs/design.md#three-levels-of-control`) — and one static
    // import from the main entry or from the provider defeats that for every application at once,
    // silently, because nothing about a bundle that got 12 KB larger reports itself.
    //
    // Scoped to `src` deliberately: an EXAMPLE importing the subpath is the correct way to opt in, and
    // is exactly what the demonstrator does. What is forbidden is the LIBRARY reaching for its own
    // Level 2 module, which would collapse two independent conditions — importing and granting — into
    // one, so an operator granting a capability would be shipping code rather than permitting it.
    //
    // Like the row above, this one is described rather than spelled: written between quotes, the
    // specifier would match its own comment.
    subject: 'the Level 2 DOM module',
    owner: join('src', 'dom'),
    scope: ['src'],
    // **`./` as well as `../`, and this row shipped without it for one commit.** The break-it added a
    // sibling import to `src/index.ts` — the single most likely place for this violation, since it is
    // the main entry the whole tree-shaking claim rests on — and the row stayed GREEN, because
    // `'./dom/index.ts'` has no `../` in it. The row above this one records the same lesson from a
    // different direction: a seam that catches one spelling of the thing it forbids is a seam that
    // reports success, which is a hidden unknown rather than a pass.
    pattern: /['"](?:@agent-mcp\/react\/dom|(?:\.\.?\/)+dom\/)/,
    why: 'Level 2 is reachable only when an application deliberately imports it AND an operator grants the capability; a static import from anywhere else in the library would put the DOM tools in every build of every embedder, defeating the subpath export that keeps them out',
  },
  {
    // **The same rule as the row above, for a larger blast radius.** A Level 2 leak is DOM control; a
    // Level 3 leak is the whole origin, and `runtime.evaluate` is to be treated as equivalent to
    // privileged code execution in the application's own origin
    // (`docs/javascript-evaluation.md`). Code that is not in the bundle cannot be reached
    // by any capability, any page script, or any mistake, and that is the only one of this tool's four
    // conditions an operator cannot switch on after the fact.
    //
    // Scoped to `src`, so an EXAMPLE importing the subpath — the correct way to opt in — is allowed.
    // Described rather than spelled, like the rows above.
    subject: 'the Level 3 evaluation module',
    owner: join('src', 'evaluate'),
    scope: ['src'],
    pattern: /['"](?:@agent-mcp\/react\/evaluate|(?:\.\.?\/)+evaluate\/)/,
    why: 'a build that never imports Level 3 must not contain it; a static import from anywhere else in the library would put arbitrary same-origin evaluation into every build of every embedder, where no capability could take it back',
  },
];

/** Every source file the rules apply to: the library, the demonstrators and the local tooling. */
async function sourceFiles(
  roots: readonly string[] = ['src', 'examples', 'tools'],
): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(resolve(repoRoot, dir), { withFileTypes: true });
    } catch {
      return; // A root that does not exist yet is not a violation.
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        await walk(path);
        continue;
      }
      if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) found.push(path);
    }
  }

  for (const root of roots) await walk(root);
  return found;
}

async function read(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), 'utf8');
}

/**
 * The source with its comments blanked, line structure and every offset preserved.
 *
 * **This exists because the same class of false positive has now bitten this repository three times**,
 * and the workaround was getting worse each time. A seam row is about what the CODE reaches; prose that
 * names the forbidden thing — a doc comment showing an author how to import the module, a comment
 * explaining why a row exists — is not a reach. Two rows above carry careful wording that describes
 * their specifier instead of spelling it, purely to avoid matching themselves, and the third instance
 * was a provider doc comment whose whole value is the usage example it shows.
 *
 * Rewording the documentation to satisfy the check is fixing the instance; this fixes the class
 * — fix the mechanism, not the occurrence. The two "described rather than spelled" comments stay as
 * they are — they remain true,
 * and a seam that holds for two reasons is not worse than one that holds for one.
 *
 * A real scanner rather than a regex, because a regex cannot tell `//` inside a string from a comment,
 * and `'https://example.com'` would otherwise be truncated mid-literal. It tracks the three quote
 * kinds, both comment forms and escapes. It does NOT parse: a regex literal containing a quote
 * character would confuse it, and no source in this repository has one — if that changes, this
 * function is where the failure surfaces, loudly, as a seam row matching something it should not.
 */
function withoutComments(source: string): string {
  const out = source.split('');
  let i = 0;
  let quote: string | undefined;
  let comment: 'line' | 'block' | undefined;

  const blank = (at: number): void => {
    if (out[at] !== '\n') out[at] = ' ';
  };

  while (i < source.length) {
    const char = source[i] as string;
    const next = source[i + 1];

    if (comment === 'line') {
      if (char === '\n') comment = undefined;
      else blank(i);
      i += 1;
      continue;
    }
    if (comment === 'block') {
      blank(i);
      if (char === '*' && next === '/') {
        blank(i + 1);
        comment = undefined;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (quote !== undefined) {
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === quote) quote = undefined;
      i += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      comment = 'line';
      continue;
    }
    if (char === '/' && next === '*') {
      comment = 'block';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      i += 1;
      continue;
    }
    i += 1;
  }

  return out.join('');
}

/** Whether `path` sits inside `owner`. */
function isInside(owner: string, path: string): boolean {
  return !relative(owner, path).startsWith('..');
}

describe('each platform surface is named in exactly one directory', () => {
  for (const seam of SEAMS) {
    it(`finds no reference to ${seam.subject} outside ${seam.owner}/`, async () => {
      const offenders: string[] = [];

      for (const path of await sourceFiles(seam.scope)) {
        if (isInside(seam.owner, path)) continue;
        // Comments blanked, offsets preserved — a row reports the line a reader can open, and the
        // ORIGINAL text is what it quotes, so a violation is legible rather than a row of spaces.
        const source = withoutComments(await read(path));
        const original = (await read(path)).split('\n');
        for (const [line, text] of source.split('\n').entries()) {
          const scanned = seam.allow === undefined ? text : text.replace(seam.allow, '');
          if (seam.pattern.test(scanned)) {
            offenders.push(`${path}:${line + 1} — ${(original[line] ?? text).trim()}`);
          }
        }
      }

      expect(
        offenders,
        `these files reach ${seam.subject} directly. Only ${seam.owner}/ may do that, because ${seam.why}:\n${offenders.join('\n')}`,
      ).toEqual([]);
    });
  }

  it('checks a seam whose owner actually exists, so a row cannot pass by vacancy', async () => {
    // A seam naming a directory that was renamed or never created would pass every run above while
    // checking nothing, which is the failure mode a table-driven check invites: a hidden unknown
    // reported as a pass.
    for (const seam of SEAMS) {
      const files = await sourceFiles(seam.scope);
      expect(
        files.some((path) => isInside(seam.owner, path)),
        `${seam.owner}/ holds no source files, so its seam row checks nothing`,
      ).toBe(true);
    }
  });
});

describe('the registry boundary stays a leaf', () => {
  it('imports no React, no socket and nothing that decides policy', async () => {
    const boundary = join('src', 'webmcp');
    const forbidden = [
      { pattern: /from\s+['"]react/, rule: 'React is imported in src/react/ and nowhere else' },
      { pattern: /\bnew\s+WebSocket\b/, rule: 'a WebSocket appears only in src/transport/' },
      {
        pattern: /from\s+['"][^'"]*\/security\//,
        rule: 'the boundary decides no policy; src/security/ decides what may happen',
      },
      {
        pattern: /from\s+['"][^'"]*\/runtime\//,
        rule: 'the boundary is a leaf — it imports nothing of this library’s own',
      },
    ];
    const violations: string[] = [];

    for (const path of await sourceFiles()) {
      if (!isInside(boundary, path)) continue;
      const source = await read(path);
      for (const { pattern, rule } of forbidden) {
        if (pattern.test(source)) violations.push(`${path} — ${rule}`);
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('reaches the portability layer through a dynamic import only', async () => {
    const source = await read(join('src', 'webmcp', 'registry.ts'));

    // A static import would initialize the layer when this module evaluates — installing a registry, a
    // deprecated host alias and a testing surface into every document that loads this library, whether
    // or not a provider ever mounts.
    expect(source).not.toMatch(/^import\s[^\n]*@mcp-b\/webmcp-polyfill/m);
    expect(source).toMatch(/await import\(['"]@mcp-b\/webmcp-polyfill['"]\)/);
  });
});

describe('the inspector can explain and cannot act', () => {
  it('imports nothing that holds a tool, a gate or a connection', async () => {
    // Authority only narrows: no devtool may widen what the provider's capabilities admit, so the
    // inspector must not be able to invoke, enable or register anything. That
    // is enforced HERE, at the module boundary, rather than by a `readonly` a cast erases: a module
    // that never imports the runtime cannot reach an ownership record, and one that never imports the
    // registry boundary cannot reach a handler, whatever a future edit inside it intends.
    //
    // It reads `window.__AGENT_MCP__` instead — a channel the provider installs, carrying data and a
    // subscription and nothing callable. That indirection is also what keeps this directory out of an
    // application's bundle: the provider does not import it, so nothing pulls it in but an explicit
    // import of the `/devtools` subpath.
    const devtools = join('src', 'devtools');
    const forbidden = [
      {
        pattern: /from\s+['"][^'"]*\/runtime\//,
        rule: 'the inspector holds no runtime, and therefore no ownership record and no gate',
      },
      {
        pattern: /from\s+['"][^'"]*\/webmcp\//,
        rule: 'the inspector holds no registry boundary, and therefore reaches no tool handler',
      },
      {
        pattern: /from\s+['"][^'"]*\/react\//,
        rule: 'the inspector is framework-free and does not reach into the provider',
      },
      {
        pattern: /\b(document|navigator)\s*\.\s*modelContext\b/,
        rule: 'the tool registry is reached only through src/webmcp/, and never by a development surface',
      },
      {
        pattern: /\bnew\s+WebSocket\b/,
        rule: 'a socket appears only in src/transport/',
      },
    ];
    const violations: string[] = [];

    for (const path of await sourceFiles()) {
      if (!isInside(devtools, path)) continue;
      const source = await read(path);
      for (const { pattern, rule } of forbidden) {
        if (pattern.test(source)) violations.push(`${path} — ${rule}`);
      }
    }

    expect(violations).toEqual([]);
  });
});

describe('the imperative registration API is not a runtime and not a renderer', () => {
  it('constructs no server, opens no socket, and imports React only as erased types', async () => {
    // **`src/actions/` exists so an application can declare a tool from code that is not a component**
    // — a shell, a singleton service, a router. Two things must stay true of it, and neither is
    // guaranteed by a type.
    //
    // It must NOT become a runtime. A runtime an application constructs would be a second
    // MCP server on one page, and `provider.tsx` already names what that produces: "two sockets from
    // one page, which presents as duplicate tool calls rather than as a connection error". What ships
    // is a place to DECLARE tools; the provider stays the only thing that serves them.
    //
    // And it must be importable from a singleton service without dragging the renderer in — which is
    // why it is its own directory rather than a corner of `src/react/`. `import type` is erased at
    // compile time and is therefore permitted; a VALUE import from React is not.
    const actions = join('src', 'actions');
    const forbidden = [
      {
        pattern: /from\s+['"]react(\/|['"])/,
        rule: 'the imperative API must not pull the renderer in',
      },
      {
        pattern: /\bcreateMcpRuntime\b|\bnew\s+Server\b/,
        rule: 'this is a registration API, never a second runtime — an application that constructed one would be a second MCP server on one page',
      },
      {
        pattern: /\bnew\s+WebSocket\b/,
        rule: 'a socket appears only in src/transport/, and never here',
      },
      {
        pattern: /\b(document|navigator)\s*\.\s*modelContext\b/,
        rule: 'the registry is reached only through src/webmcp/, and only by the provider that serves',
      },
    ];
    const violations: string[] = [];

    for (const path of await sourceFiles()) {
      if (!isInside(actions, path)) continue;
      const source = await read(path);
      // Type-only imports are erased by the compiler, so they cannot pull a module in at runtime.
      // Subtracted before matching rather than excused afterwards, so the check stays exact.
      const runtimeCode = source.replace(
        /import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];?/g,
        '',
      );
      for (const { pattern, rule } of forbidden) {
        if (pattern.test(runtimeCode)) violations.push(`${path} — ${rule}`);
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('lets the adapters be used from code that never renders', async () => {
    // An adapter binds a store action to a tool. A store binding may be registered outside React
    // components, and each adapter is an imperative function rather than a hook
    // (`docs/store-adapters.md`) — so an adapter that required a renderer would contradict what it
    // is for.
    const adapters = join('src', 'adapters');
    const violations: string[] = [];

    for (const path of await sourceFiles()) {
      if (!isInside(adapters, path)) continue;
      const source = await read(path);
      const runtimeCode = source.replace(
        /import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];?/g,
        '',
      );
      if (/from\s+['"]react(\/|['"])/.test(runtimeCode)) {
        violations.push(`${path} — an adapter must be usable outside React`);
      }
      if (/\bcreateMcpRuntime\b/.test(runtimeCode)) {
        violations.push(`${path} — an adapter declares tools; it never constructs a runtime`);
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('the runtime knows nothing about React, the DOM or the socket', () => {
  it('imports no React, opens no socket and reaches the registry only through the boundary', async () => {
    const runtime = join('src', 'runtime');
    const forbidden = [
      { pattern: /from\s+['"]react/, rule: 'React is imported in src/react/ and nowhere else' },
      {
        pattern: /\bnew\s+WebSocket\b/,
        rule: 'the runtime is handed a transport; it never opens a connection',
      },
      {
        pattern: /\b(document|navigator)\s*\.\s*modelContext\b/,
        rule: 'the tool registry is reached only through src/webmcp/',
      },
      {
        pattern: /\bdocument\s*\.\s*(querySelector|getElementById|createElement|body)\b/,
        rule: 'the runtime touches no DOM — that is what lets it be tested without a renderer',
      },
      {
        pattern: /from\s+['"][^'"]*\/react\//,
        rule: 'the dependency runs react → runtime, never the reverse',
      },
    ];
    const violations: string[] = [];

    for (const path of await sourceFiles()) {
      if (!isInside(runtime, path)) continue;
      const source = await read(path);
      for (const { pattern, rule } of forbidden) {
        if (pattern.test(source)) violations.push(`${path} — ${rule}`);
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('the React binding owns lifecycle and nothing else', () => {
  it('opens no socket, names no registry host, and decides no policy', async () => {
    const react = join('src', 'react');
    const forbidden = [
      {
        pattern: /\bnew\s+WebSocket\b/,
        rule: 'the provider is handed a transport it built through the factory; a socket appears only in src/transport/',
      },
      {
        pattern: /\b(document|navigator)\s*\.\s*modelContext\b/,
        rule: 'the tool registry is reached only through src/webmcp/, which is also the only module that checks for a secure context',
      },
      {
        pattern: /from\s+['"][^'"]*\/security\//,
        rule: 'a capability check reached from here would be a gate outside the runtime, which is a gate a module can be imported past',
      },
    ];
    const violations: string[] = [];

    for (const path of await sourceFiles()) {
      if (!isInside(react, path)) continue;
      const source = await read(path);
      for (const { pattern, rule } of forbidden) {
        if (pattern.test(source)) violations.push(`${path} — ${rule}`);
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('the demonstrators consume the package, they do not reach into it', () => {
  it('deep-imports nothing from src/', async () => {
    // An example that imported an internal would be a demonstrator of something no embedder can do —
    // and would keep working while the public surface it is supposed to prove was broken.
    const offenders: string[] = [];

    for (const path of await sourceFiles()) {
      if (!isInside('examples', path) && !isInside('tools', path)) continue;
      const source = await read(path);
      for (const [line, text] of source.split('\n').entries()) {
        if (/from\s+['"][^'"]*(\.\.\/)+src\//.test(text)) {
          offenders.push(`${path}:${line + 1} — ${text.trim()}`);
        }
      }
    }

    expect(
      offenders,
      `these reach into src/ directly. Examples and tools consume the package's public entry points, exactly as an embedder does:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('the transport stays a leaf too', () => {
  it('imports no React, touches no tool registry and decides no policy', async () => {
    const transport = join('src', 'transport');
    const forbidden = [
      { pattern: /from\s+['"]react/, rule: 'React is imported in src/react/ and nowhere else' },
      {
        pattern: /\b(document|navigator)\s*\.\s*modelContext\b/,
        rule: 'the tool registry is reached only through src/webmcp/',
      },
      {
        pattern: /from\s+['"][^'"]*\/(security|runtime|react|webmcp)\//,
        rule: 'the transport carries frames and reads none of them — it imports nothing of this library’s own',
      },
    ];
    const violations: string[] = [];

    for (const path of await sourceFiles()) {
      if (!isInside(transport, path)) continue;
      const source = await read(path);
      for (const { pattern, rule } of forbidden) {
        if (pattern.test(source)) violations.push(`${path} — ${rule}`);
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('a page identity is minted, never written by hand', () => {
  // **Not a seam row, and the distinction matters.** A seam says one directory owns a platform
  // surface. This says a LITERAL must appear nowhere — there is no owner, so expressing it as a seam
  // would mean naming a file that owns nothing and the vacancy check would rightly reject it.
  //
  // It is a static check and it does not pretend otherwise: what it catches is the wiring being
  // reverted, which is the regression a behavioural case in this repository cannot catch, because
  // every one of them supplies its own correct wiring rather than importing the demonstrator's. The
  // behavioural proof is the live run.

  it('is not spelled as a string in any example that dials an agent', async () => {
    const hardcoded = /searchParams\s*\.\s*set\(\s*['"]tabId['"]\s*,\s*['"]/;
    const offenders: string[] = [];

    for (const path of await sourceFiles(['examples'])) {
      const source = await read(path);
      for (const [line, text] of source.split('\n').entries()) {
        if (hardcoded.test(text)) offenders.push(`${path}:${String(line + 1)}`);
      }
    }

    expect(
      offenders,
      'an identity written by hand is unique only by luck, and two copies of one page then collide — ' +
        'which happened on 2026-08-25, when both dialled as "dashboard" and a request naming that id ' +
        'was answered by whichever connected first. The library mints one per page instance; an ' +
        'application appends THAT, never a string it chose',
    ).toEqual([]);
  });

  it('catches the wiring being reverted, which is the only thing this case is for', async () => {
    // The pattern proved against a sample rather than trusted. A regex that matched nothing would make
    // the case above pass for every possible source file, and it would look exactly like success.
    const hardcoded = /searchParams\s*\.\s*set\(\s*['"]tabId['"]\s*,\s*['"]/;
    expect(hardcoded.test("dial.searchParams.set('tabId', 'dashboard');")).toBe(true);
    expect(hardcoded.test('dial.searchParams.set("tabId", "dashboard");')).toBe(true);
    // And the correct wiring is not flagged.
    expect(hardcoded.test("dial.searchParams.set('tabId', tabId);")).toBe(false);
  });
});
