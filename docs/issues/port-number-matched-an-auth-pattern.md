*Dated material — a defect record, written 2026-08-28 and describing that moment; current behaviour is in the pages under docs/.*

# A flaky case: a random port contained `401`

**Status: FIXED 2026-08-28.** Cause established, fix verified in both directions.

## What was seen

`pnpm test:transport` failed once in six runs:

```
FAIL tests/transport/browser/causes.spec.ts
  > every cause this module produces > never names an authentication rejection

AssertionError: expected 'the connection to ws://127.0.0.1:54017/ could not be established'
                not to match /auth|401|unauthorized|forbidden|credential|ticket/i
```

## The cause

**The port was `54017`.** It contains `401`.

The case asserts that a transport failure message never names an authentication rejection — a real and
important rule, because a page genuinely cannot tell a refused handshake from a dead port, and a
message that implied otherwise would be wrong every time the gateway was merely down.

The **prose** obeyed that rule perfectly. The **data** in the message — a URL with an ephemeral port
the operating system assigned — happened to contain the digits the pattern looks for. It failed
roughly one run in six, which is about the rate at which a random five-digit port contains `401`.

## The fix

Strip the URL before matching:

```ts
const prose = failure.message.replace(/wss?:\/\/\S+/g, '<url>');
expect(prose, failure.message).not.toMatch(/auth|401|…/i);
```

**This is a fix rather than a loosening**, and the distinction decided the approach. The alternatives
were to drop `401` from the pattern or to add word boundaries — both weaken the assertion on the half
that matters. A future message genuinely containing "HTTP 401" would then match a port and pass.

Verified in both directions:

| Input | Matches |
|---|---|
| the observed message, raw | yes — the bug |
| the observed message, URL stripped | **no** |
| `rejected: HTTP 401 unauthorized`, URL stripped | **yes** — still caught |

Six consecutive clean runs after.

## Why it took this long to catch

The message is only produced by a failed connection to a gateway on an ephemeral port, and only one
case asserts against it. One run in six, in a suite nobody watches character by character.

## What it says about the other open flake

`second-provider-intermittent.md` remains open with its cause **not** established, and this one is not
evidence about it — different file, different signature. What the two share is a lesson already
recorded there and repeated here: **the failure text was allowed to scroll past the first time**, and
a second sighting was needed to catch it. Capture the output.
