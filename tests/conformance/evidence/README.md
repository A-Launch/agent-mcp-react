# Evidence

`webmcp-41d12f0.bs` is `index.bs` from the WebMCP draft's repository,
[`webmachinelearning/webmcp`](https://github.com/webmachinelearning/webmcp), verbatim, at commit
**`41d12f057167ccf5954dbcf49d99502cb6c84491`** (2026-08-26, *"Clarify sentence regarding origins and
`exposedTo` (#260)"*). Upstream's commit is the canonical text; this file is a copy held so that a
quotation can be checked without a network call and without trusting that upstream still says what it
said the day the conformance cases were written.

Reproduce it:

```bash
gh api "repos/webmachinelearning/webmcp/contents/index.bs?ref=41d12f057167ccf5954dbcf49d99502cb6c84491" \
  --jq '.content' | base64 -d > webmcp-41d12f0.bs
```

Nothing builds against it and nothing imports it. The cases under `tests/conformance/` cite line
ranges in it, and `docs/conformance.md` records what each case found.

## License

The draft's repository licenses its reports under the
[W3C Software and Document License (2023)](https://www.w3.org/copyright/software-license-2023/),
per its `LICENSE.md` at the pinned commit (read on 2026-09-08). That license permits copying and
redistribution on condition that its full notice accompanies every copy, so the notice is reproduced
in [LICENSE.md](LICENSE.md) beside the file. The repository-level `NOTICE` points here.
