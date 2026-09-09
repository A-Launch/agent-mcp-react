# Changelog

All notable changes to `agent-mcp-react` are recorded here. The format follows
[Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> *Dated material.* The entries below describe moments. Current behaviour is in [docs/](docs/README.md),
> and where an entry and a page disagree, the page is right.

## [Unreleased]

Nothing yet.

## [0.2.3] — 2026-09-09

### Added

- **The README opens with a recording** of an agent composing a dashboard by calling the tools the page
  declared — a twenty-second excerpt inline, linking the full three minutes. The left pane is the
  agent's real tool calls.

### Changed

- `docs/media/` is exempt from the `citation` and `vocabulary` rules of the publish check, and from
  nothing else. Compressed video is scanned like every other file and decodes to stray section marks
  and short tokens by chance — 161 and 1790 findings on one recording — which is noise by
  construction. `credential`, `personal-path` and `copyright-owner` still apply there, because those
  patterns do not arise by accident.

## [0.2.2] — 2026-09-09

Documentation only. `src/` is unchanged from [0.2.1](docs/releases/0.2.1.md).

### Changed

- **The README carries two quickstarts** — one for using the package, one for working on the library —
  and leads with the registry install, which is now the ordinary route. Released so that the README on
  the registry says what the repository says: npm serves the README from the published tarball, so a
  documentation change reaches a package page only by being published.
- **No document restates the package version.** The packed tarball's name appeared in six places
  across three pages, each of which had to be swept at every release and was twice found stale.
  `package.json` owns the version and the pages no longer repeat it.

## [0.2.1] — 2026-09-09

### Fixed

- **`0.2.0` was published broken and is deprecated. Install `0.2.1`.** Its manifest declared every
  subpath as `./src/*.ts`, and `src/` is not in the package — so every import from it failed. The
  release workflow published the working tree with `npm`, and `publishConfig` field overrides, which
  rewrite the `exports` map to point at `dist/`, are a **pnpm** feature that `npm publish` does not
  apply. `pnpm pack` produced a correct tarball throughout, which is why every check was green: the
  artifact the checks validated was never the artifact being uploaded. The workflow now packs with
  pnpm, asserts that tarball resolves every export it declares, and publishes that same file.

## [0.2.0] — 2026-09-09

The first release published from this repository, and the version its `v0.2.0` tag names. Its notes
are in [docs/releases/0.2.0.md](docs/releases/0.2.0.md).

### Added

- **The repository is public.** A contributor guide that owns every convention (`CONTRIBUTING.md`),
  a code of conduct, a security policy, issue and pull-request templates, a CI workflow whose `gate`
  job is the check branch protection requires, and a single `pnpm gate` script that runs the whole
  health gate. A publish check (`pnpm verify:public`) asserts that nothing in the tree cites a
  document that is not in it.
- **The design document.** [docs/design.md](docs/design.md) states every claim a page or a source
  comment relies on, under a stable heading, so a comment can link the design rather than a number.
- **Explanation and reference pages.** Why MCP is a second control interface, why registration
  follows the commit, what an agent can and cannot reach, the full API, the capability reference and
  the error vocabulary — including the rule that a thrown handler message is replaced outside a
  development build, so guidance an agent should act on must be returned.
- **A second demonstrator.** `examples/composable-board` on port 45030: a dashboard whose layout an
  agent composes from a closed catalog of panel kinds — table, metric, chart, form, map, timeline,
  pipeline — with per-panel tools and a real world map drawn from bundled geography with no network.
- **A conformance layer.** `tests/conformance/` pins every behaviour this library relies on in an
  adopted package — the portability shim and the MCP SDK server — against the real package, and a
  browser case asserts the same of the built bundle. An opt-in lane (`pnpm test:e2e:native`) runs the
  page against Chromium's own tool registry; [docs/conformance.md](docs/conformance.md) records the
  findings and the divergences from the draft standard.
- **External consumability checks.** `pnpm verify:consumer` installs the packed tarball into a project
  outside the repository, typechecks it against the shipped types and bundles it; `pnpm
  verify:consumer:runs` serves that bundle and asserts it mounts.
- **Transport documentation.** [docs/websocket-framing.md](docs/websocket-framing.md) and
  [docs/connection-lifecycle.md](docs/connection-lifecycle.md).

### Changed

- **Validation under a strict Content-Security-Policy.** The bundled validator compiles schemas with
  `new Function` and needs `unsafe-eval`; an application under a strict policy would expose no tools
  at all. The customer dashboard now ships a validator that needs no evaluation, and the defect and
  its options are recorded in
  [docs/issues/validator-requires-unsafe-eval.md](docs/issues/validator-requires-unsafe-eval.md).
- **The README** is written for a reader who has never seen the project: what it does, whether it
  fits, install, the minimal wiring, what you must supply, what will bite you.

## [0.1.0] — 2026-08-27

The first release, made before this repository existed. Its notes are kept in
[docs/releases/0.1.0.md](docs/releases/0.1.0.md).

**There is no `v0.1.0` tag here, deliberately.** The tree this release was built from is not in this
repository's history, which begins at the initial public import. A tag of that name could only point
at a later tree and misdescribe itself, so the entry links its notes instead of a tag.

[Unreleased]: https://github.com/A-Launch/agent-mcp-react/compare/v0.2.3...develop
[0.2.3]: https://github.com/A-Launch/agent-mcp-react/releases/tag/v0.2.3
[0.2.2]: https://github.com/A-Launch/agent-mcp-react/releases/tag/v0.2.2
[0.2.1]: https://github.com/A-Launch/agent-mcp-react/releases/tag/v0.2.1
[0.2.0]: https://github.com/A-Launch/agent-mcp-react/releases/tag/v0.2.0
[0.1.0]: docs/releases/0.1.0.md
