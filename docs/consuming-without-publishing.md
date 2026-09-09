# Consuming the library without publishing it

Everything here was measured against this repository rather than reasoned about, because three of the
four routes below fail in ways that still exit `0`.

| Route | Works | Why |
|---|---|---|
| **A packed tarball** (`file:…/agent-mcp-react-0.2.0.tgz`) | **Yes** | The recommended route. Verified end to end by `pnpm verify:consumer` |
| **A pnpm workspace** | **Yes** | How `examples/*` consume it in this repository |
| **A git URL** | **On npm and yarn.** Awkward on pnpm | Needs a build on install; pnpm blocks lifecycle scripts by default |
| **A local directory** (`file:../agent-mcp-react`) | **No** | `publishConfig` does not apply, so the export map points at `src/` |

## The tarball — the route to use

```bash
# In this repository
pnpm pack                 # → agent-mcp-react-0.2.0.tgz  (runs `prepare`, so dist/ is always fresh)
```

```jsonc
// In the consuming project's package.json
{
  "dependencies": {
    "@agent-mcp/react": "file:../agent-mcp-react/agent-mcp-react-0.2.0.tgz"
  }
}
```

Nothing else. No lifecycle scripts, no allowlists, no build step in the consumer, and it behaves
identically on npm, pnpm and yarn — because a tarball is exactly what a registry would have served.

**`pnpm pack`, never `npm pack`.** Only pnpm applies the `publishConfig` field overrides that point the
export map at `dist/`. An `npm pack` tarball installs cleanly and resolves none of its exports.

This is the route `pnpm verify:consumer` exercises on every gate run: it packs, installs into a project
outside this repository, typechecks against the shipped types and bundles with a real bundler.
`pnpm verify:consumer:runs` additionally loads that bundle in a browser.

## A git URL — works on npm and yarn

```jsonc
{ "dependencies": { "@agent-mcp/react": "github:A-Launch/agent-mcp-react#develop" } }
```

`dist/` is **not** committed, so the package has to be built after cloning. `package.json` declares
`"prepare": "pnpm build"`, which npm and yarn run automatically for a git dependency.

**On pnpm this fails by default, and the failure is loud rather than silent** — pnpm 10+ refuses to run
a dependency's lifecycle scripts unless the consumer allowlists it, and it prints the exact entry to
add. The entry names the **resolved commit**, so it changes every time the branch moves. That is
tolerable for a pin and unpleasant for a branch, which is why the tarball is the recommendation.

**Without `prepare` this route produces a package that is installed and unusable** — `LICENSE`,
`NOTICE`, `README.md`, `package.json` and no `dist/`, with every export pointing at a file that does
not exist. The install still exits `0`. Measured, not imagined, on 2026-08-30.

## A local directory — does NOT work

```jsonc
{ "dependencies": { "@agent-mcp/react": "file:../agent-mcp-react" } }   // ✗
```

This is the most natural thing to try and it is the one route that cannot work. **`publishConfig` is
applied when a package is PACKED, never when a directory is linked**, so the consumer gets the
development export map — which points at `./src/*.ts`, and `src/` is not in `files`. `dist/` is copied
and nothing points at it.

The symptom is partial and therefore confusing: some imports resolve and subpaths like
`@agent-mcp/react/validation` report `TS2307: Cannot find module`. Pack the tarball instead.

## A pnpm workspace — for a monorepo

If the consuming application lives in the same workspace, use the workspace protocol:

```jsonc
{ "dependencies": { "@agent-mcp/react": "workspace:*" } }
```

This is how `examples/customer-dashboard` consumes the library. It resolves to the development export
map pointing at `src/`, which is what makes an edit visible without a rebuild — and it is also why
`examples/*` prove nothing about the packaged artifact. That is `verify:consumer`'s job.

## See also

- [Tutorial: your first agent-callable tool](tutorial-first-tool.md) — once it is installed
- [The conformance layer](conformance.md) — what is verified against adopted packages
- `pnpm verify:consumer` and `pnpm verify:consumer:runs` in the README's health gate section
