# Priority scheduler

Off by default. With `scheduler.enabled`, the proxy paces the fleet so that its
quota runs out exactly when the window resets, and holds requests by priority to
keep to that pace.

```json
{
  "scheduler": { "enabled": true }
}
```

## Priorities

Every Claude Code session runs at one of three levels:

| Level | Waits? | May exceed the pace? |
| --- | --- | --- |
| **1** realtime | Never. Sent at once, ahead of everything, and past the upstream connection cap. | Yes. This is *overdrive*. |
| **2** | Until the pace covers it. | No. |
| **3** | Until the pace covers it **and** no level-2 request is waiting. Starves while level 2 has work. | No. |

Sessions at the same level share the pace by what each has spent, so one agent
with many parallel requests does not crowd out another sending one at a time.
Subagents a Claude Code session starts in-process share its session, and so its
level.

A session's level is the first one found, in this order:

1. an operator override, set from the TUI's sessions screen or with
   `POST /teamclaude/session-priority`
   `{"sessionId": "<x-claude-code-session-id>", "priority": 1 | 2 | 3 | null}`
   (`null` clears it). Refused for `proxy.clientKeys` keys, like session pins.
   Runtime only.
2. the `x-teamclaude-priority` header the client sends, which
   `teamclaude run --priority N` (or `TC_PRIORITY=N`, which `run` and `env`
   both read) sets through Claude Code's `ANTHROPIC_CUSTOM_HEADERS`. The header
   is never forwarded upstream.
3. the level of the session it was launched from, found the same way, live: set
   a coordinator to 1 and every worker it launched with no level of its own runs
   at 1 until you change it.
4. `scheduler.defaultPriority` (2 unless set).

Any client that can reach the proxy can ask for level 1 with the header.

Requests sent through a `/tc-acct/` path pin (the keep-warm scheduler, manual
tests), non-completion calls and Codex traffic are never held.

## Sessions

The TUI's `a` key (also in `teamclaude attach`) lists every Claude Code
session the proxy has seen in the last hour as a tree: each session, the
subagents running in it, then the sessions it launched. Each row shows the
level, where it came from (`set`, `asked` by header, `inherited`, `default`),
the working directory, and how many requests are running and held. `↑`/`↓`
select a session, `1`/`2`/`3` set its level and `0` clears it. The tree is also
`sessions` in the `scheduler` block of `/teamclaude/status`.

Subagents come from the headers Claude Code sends with each request. A session
launched by another one is found two ways:

- On Linux, for a client on the same machine and user, the proxy reads the
  client's process tree: the parent is the session whose `claude` process the
  new one descends from, as when an agent runs `claude` from its Bash tool or
  through `teamclaude run`.
- `teamclaude run` sends the session it was started from as
  `x-teamclaude-parent-session` (never forwarded). Everything a session starts
  inherits that header, so where the process tree names a different parent,
  the tree wins, and the inherited priority header is ignored too: the session
  follows its real parent instead.

A session started outside its parent's process tree, such as in another
terminal tab, shows at the top level.

## The pace

For each Claude account in service, every window with a reading (the 5-hour and
the weekly one) allows

```
tier weight × (limit − utilization) / (time until that window resets)
```

where `limit` is the account's `maxUsage` cap for that window, or 1. The account
is paced by the lower of its windows, and the fleet's pace is the sum over its
accounts. The pace is recomputed from the live readings every 15 seconds and
after every request. Because it is always "what is left over the time left", it
corrects itself: a quiet hour raises it, a burst lowers it, and the fleet still
arrives at its limit when the window resets.

Readings are utilization; requests report tokens. The proxy learns how much
weekly quota one token moves from the fleet's own readings, weighting a cache
read at 0.1 of an input token, a cache write at 1.25 and an output token at 5.
**Until that rate has been learned (at least five minutes of traffic that moves a
weekly reading), every request passes straight through**, the same as with no
quota readings at all.

Each request is admitted on an estimate (its prompt size, how much of it the
session's prompt cache still holds, and the session's recent output length) and
charged what upstream reports when it finishes.

## Overdrive

A level-1 request is sent whatever the pace allows. When that pushes spending
past the pace, the scheduler is in **overdrive**, and the excess is a debt.
Levels 2 and 3 wait until the debt is repaid at the pace, then continue. The
pace is recomputed from the readings afterwards, so the pause does not leave
quota unspent at the reset.

Overdrive goes no further than the accounts' real limits: when every account is
spent, level 1 is refused like everything else.

Overdrive is always visible:

- the proxy log prints a line when overdrive starts (naming the level-1
  sessions driving it), when it ends (with how much is owed and when levels 2
  and 3 resume) and when the debt is repaid;
- `teamclaude status` shows a **Scheduler** row and, during overdrive, an
  **Overdrive** row;
- the dashboard's summary line shows both;
- `/teamclaude/status` carries the full `scheduler` block (mode, pace, debt,
  queue, overdrive sessions, a projection of when the fleet hits its limit at
  the current spend rate, and the last 20 overdrive episodes);
  `/teamclaude/quota` carries a compact `scheduler` block for status lines.

## Holding

A held request is not answered until it is admitted. If it is still waiting
after `scheduler.maxHoldSeconds`, it gets a `429 rate_limit_error` with a
`retry-after` and `error_code: scheduler_hold_expired`. With the scheduler on,
`teamclaude run` and `teamclaude env` raise Claude Code's `API_TIMEOUT_MS` to
that hold plus a minute, as they do for `holdSeconds`. A client launched another
way needs the same.

A request held past the prompt cache's lifetime costs a full cache write when it
goes. The estimate counts that, so a long-held session is admitted on its real
cost.

## Settings

| Field | Default | |
| --- | --- | --- |
| `scheduler.enabled` | `false` | Turns the scheduler on |
| `scheduler.defaultPriority` | `2` | Level for a session that asks for none |
| `scheduler.depthSeconds` | `300` | Seconds of pace that can be spent in a burst without waiting |
| `scheduler.maxHoldSeconds` | `3600` | Longest a level-2 or level-3 request waits before it is refused |
| `scheduler.cacheTtlSeconds` | `300` | How long a session's prompt prefix is assumed to stay cached |

Read at startup; a change needs a restart. An unknown field or a bad value is
refused at startup.

## Limits

- One proxy, one scheduler. Several proxies sharing accounts each pace
  themselves from the same readings. The fleet still lands on its limit at the
  reset (each proxy sees the others' spending in the readings), but spends more
  of the window early, and priorities apply only within each proxy.
- A worker started outside its parent's process tree does not inherit its
  level; set it from the sessions screen.
