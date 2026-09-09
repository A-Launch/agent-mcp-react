# The connection state machine and backoff schedule

What `useMcpConnection` reports, when each state is reached, and what recovery actually does.

## The five states

```text
disconnected ──mount──▶ connecting ──open──▶ connected
                            │                    │
                       first attempt        channel ends
                          failed                 │
                            ▼                    ▼
                          error            reconnecting ──▶ connected
                        (terminal)              ▲   │
                                                └───┘
                                             on the schedule
```

| State | Meaning |
|---|---|
| `disconnected` | before the mount effect ran, and after teardown |
| `connecting` | an attempt is under way — obtaining the URL, opening the socket, attaching the runtime |
| `connected` | the runtime is serving over an open channel |
| `reconnecting` | an **established** channel ended and is being recovered |
| `error` | a **first** attempt failed. **Terminal** |

### Why `connecting` and `reconnecting` are separate

They mean different things to whoever is looking at the page. `connecting` is a page that has never
connected — so a configuration problem is still possible. `reconnecting` is a page that connected once,
which proves the configuration works and the network is the problem. A surface that collapsed them
could not tell somebody which they had.

### Why only an established channel is recovered

`error` is terminal and is reached **only** by an attempt that never opened a channel.

A channel that once opened proves the configuration works, so retrying is right. One that never opened
may be pointing somewhere that will never answer — and retrying forever would hide a misconfiguration
behind a spinner. That is also what keeps `error` reachable at all: recovery is unbounded, so if a
dropped channel could land there too, nothing ever would.

## The backoff schedule

```text
500ms → 1s → 2s → 4s → 8s → 15s → 30s → 30s → 30s → …
```

Seven steps, then 30 seconds indefinitely.

**Jitter is up to 25% and applies DOWNWARD only** — an interval is between 75% and 100% of its step,
never above it. That is deliberate rather than incidental: it keeps each number a **ceiling** rather
than an average, so "30 seconds maximum" is true of every interval and not just of the mean. Two pages
that dropped at the same instant diverge on their first retry, which is what the jitter is for.

The schedule **resets to the first step** once a channel is established, so a page that reconnects and
later drops again starts from 500 ms rather than from wherever it left off.

## A fresh credential per attempt, structurally

Each attempt constructs a **new transport**, never restarting one. A transport is single-use, so the
URL supplier necessarily runs again — which makes "a fresh credential per attempt" a property of the
shape rather than a rule to remember.

**The credential is obtained AFTER the backoff wait, never before**, and the ordering is load-bearing:
both orderings satisfy "a fresh credential per attempt" and behave identically until the schedule's
maximum — where the interval is 30 s and the recommended credential lifetime starts at 30 s. Getting it
wrong fails at exactly the step a real gateway restart drives you to, and invisibly, because expired,
spent and "the gateway is down" all reach a page as one cause.

## After a reconnection

The agent is re-told the current tool set. A recovered connection is a **new MCP session**, so its
first listing is whatever is mounted at that moment — not what was mounted when the previous session
ended.

Registrations survive, because the ownership record belongs to the provider rather than to the runtime:
a runtime is per-connection, and a registration is not.

## What an application sees

```tsx
const connection = useMcpConnection();
// { status: 'reconnecting', attempt: 3 }
```

`attempt` counts recovery attempts since the last established channel, and resets with the schedule.

## Verified

The reconnection path is exercised end to end in `tests/e2e/reconnect.spec.ts`, on three engines: a
socket closed by the peer, the status leaving `connected`, and a **new** socket to the gateway opening
without a page reload. The case closes only the gateway socket — closing the dev server's hot-reload channel too makes the
dev server reload the page, which would pass without the library having reconnected at all.
