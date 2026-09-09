*Dated material — a defect record, written 2026-08-28 and describing that moment; current behaviour is in the pages under docs/.*

# The bundled validator requires CSP `unsafe-eval`

**Status**: open — documented, not fixed. Recorded 2026-08-28.
**Severity**: high for any application with a strict Content-Security-Policy.

## What happens

An application served under a policy whose `script-src` omits `unsafe-eval` **gets no tools at all**.

```
[error]     Error compiling schema, function code: const schema2 = scope.schema[2];…
[pageerror] Evaluating a string as JavaScript violates the following Content Security Policy
            directive because 'unsafe-eval' is not an allowed source
```

Measured in Chromium against the demonstrator, served with
`script-src 'self' 'unsafe-inline'`.

## Why it is total rather than partial

Ajv compiles a JSON Schema into a JavaScript function with `new Function`. Under a policy without
`unsafe-eval` that throws — so `createAjvValidator(...).compile(schema)` throws at **declaration**.

And this library refuses to register a tool that declares a schema with no working validator: *"a tool
that declares a schema and has no validator installed is not registered at all"* (the invariant that
tool inputs are schema-validated before the handler runs, see
[Schemas are binding](../declaring-a-tool.md#schemas-are-binding); `MCP_TOOL_VALIDATOR_MISSING`). That
rule is correct — advertising a contract nothing checks is the condition runtime validation, landed on
2026-08-24, exists to end — but combined with the above it means a strict-CSP application
registers **nothing**, and the agent sees an empty page.

## Why it went unnoticed

Nothing in this repository ran under a CSP until 2026-08-28, when a check aimed at a different thing
first served the demonstrator with a policy header. The
failure needs three conditions at once: a real policy header, a real browser, and the library actually
declaring a schema. No test layer had all three, and the demonstrator's dev server sent no policy.

## What is affected

- `createAjvValidator`, exported from `agent-mcp-react/validation` — the validator the documentation
  recommends and the demonstrator uses.
- **Not the library's core.** `SchemaValidator` is an interface the application supplies. The seam is
  the right shape; the shipped implementation has an undisclosed requirement.

## The workaround, which is the seam working as designed

Supply a `SchemaValidator` that does not compile code. The interface is two methods:

```ts
interface SchemaValidator {
  compile(schema: Record<string, unknown>): CompiledSchema | Promise<CompiledSchema>;
}
interface CompiledSchema {
  validate(value: unknown): ValidationOutcome | Promise<ValidationOutcome>;
}
```

`examples/customer-dashboard/src/csp-safe-validator.ts` is a worked example — deliberately minimal,
and its own comment says exactly which keywords it covers and that it is not a general validator.

## Why it is not fixed in `0.1.0`

Fixing it means either shipping a second validator implementation or precompiling schemas at build
time (Ajv's standalone mode). Both are new scope, and the project's proportionate-engineering rule —
the simplest design that satisfies the requirement, with a schema-library dependency among the things
deliberately deferred until an operator asks for it — already defers this one. **The seam works**: an
application under a strict CSP supplies its own validator, which is what the interface is for.

What was wrong was not the design — it was that **no document said so**, and the documentation
recommended a validator that cannot work in a configuration the specification itself calls normal.
That is now corrected everywhere the validator is mentioned.

## What would close this

Either of:

1. A CSP-safe validator shipped from `agent-mcp-react/validation` alongside the Ajv one, chosen by the
   application.
2. Build-time schema precompilation, so no code is compiled in the browser at all.

Neither is scoped for `0.1.0`.
