# Security policy

## Reporting a vulnerability

Report privately through the repository's **Security** tab (*Report a vulnerability*). If that is
unavailable to you, email `research@thekaliper.com`.

**Never open a public issue for a vulnerability.** A reachability hole in this library is reachable
on every page that embeds it from the moment the issue is readable.

You will receive an acknowledgement within **72 hours**. For a confirmed issue you will have either a
fix or a written plan with a date within **30 days**, and you will be credited in the release notes
unless you ask not to be.

## What counts

This library's product is the guarantee that an agent reaches only what the application registered
and only what the operator granted. Anything that breaks that guarantee is a vulnerability, whatever
its severity looks like in isolation:

- an agent can reach a tool the application did not explicitly register — by discovery, by
  convention, by a registry entry this library did not make, or by a tool that stays callable after
  it was withdrawn or declared unavailable;
- one capability confers another — `application` admitting a DOM tool, `dom.inspect` admitting
  `dom.interact`, anything short of `evaluate` reaching `runtime.evaluate`, or a per-tool permission
  granting what its capability level denies;
- a credential, a ticket, a password value or a hidden input reaches an agent — in a snapshot, a
  state read, a validation diagnostic, an error or an event;
- a page script can reach a Level 2 or Level 3 tool through the shared document registry, in any
  configuration.

Also in scope: a way to make the provider register during render or before commit, a stale handler
closure that operates on a previous render's state while reporting success, and a call that reports
success before the application accepted the mutation.

## Supported versions

The latest `0.x` minor receives fixes. Earlier minors do not.

## What is not a vulnerability here

- A tool the application registered doing what its handler does. Authorization inside a handler is
  the application's, and the library documents that a capability governs its bridge and not the page.
- The mock agent runtime under `tools/`, which is a local development component and is documented as
  not for production.
- `runtime.evaluate` executing code on a page whose operator granted `evaluate` and whose person
  approved the call. That is what it is for.
