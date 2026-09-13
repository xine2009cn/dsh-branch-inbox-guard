# dsh-branch-inbox-guard

English | [中文](README.zh.md)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

Keeps a DSH fork child from inheriting its parent's queued prompts. Branch a session, type a question,
and the branch runs **your** question — not the prompt the parent had queued next.

- Pure host plugin: no core-file patching, no client half, no configuration.
- Durable: the drop is appended as a normal `agent/inbox/spliced` cancel event, so the queue stays clean across restarts.
- Idempotent, and conservative — it only removes items it can prove came from the fork parent.

## The problem it removes

A DSH branch session is a **fork child**: its log is seeded with the parent's completed-turn prefix.
That prefix can contain the parent's undelivered `agent/inbox/spliced` events — prompts you queued while
the parent was still working.

On DSH **0.1.5** the agent inbox is a session projection that folds the whole log, so those replayed
splices become the child's pending queue. The prompt you then type in the branch is appended **behind**
them, and the branch's first turn claims the parent's queued prompt instead — the question you typed
appears to vanish.

On DSH **0.1.1-rc.2** the inbox was rebuilt from the log suffix after the fork cut, so the same seed
produced an empty queue. This plugin restores that behaviour through public APIs, without patching
core packages.

```text
parent session                     branch session (fork child)
  turn 10 ─ completed                seed = parent prefix
  queue:  [A] [B]  ← undelivered     queue:  [A] [B]   ← replayed from the seed on 0.1.5
  turn 11 runs A                     you type C → queue: [A] [B] [C]
                                     first turn runs A   ← C waits, and looks lost
                                     with this plugin: queue [C] → first turn runs C
```

## What it does

On every `agent/created` it inspects the pending queue and drops exactly the items whose inserting
`agent/inbox/spliced` event lies **inside the session's inherited prefix** (`seq < session.inheritedEventCount`):

| Pending item | Action |
| --- | --- |
| Inserted before the fork cut (the parent's) | Dropped. A single `inbox.clear()` when the whole queue is inherited, otherwise one `inbox.remove(id)` per item — both recorded durably as cancels. |
| Inserted by the session's own events | Kept. A branch that already queued its own prompts (or a session resumed later) only loses the inherited ones. |
| Unseeded session (`inheritedEventCount` is 0) | Never touched. |
| Origin not traceable in the log | Kept (conservative). |

It also covers **fork-context subagents** (their seed has the same property, so a delegated task would
otherwise queue behind the parent's prompts), and it heals sessions that were polluted before you
installed it: open such a branch once and the phantom items are cancelled, while the prompt you typed
in it survives.

## Install

```bash
# from npm (prebuilt — skips the build-approval step)
dsh plugin --profile web add dsh-branch-inbox-guard

# from GitHub
dsh plugin --profile web add github:xine2009cn/dsh-branch-inbox-guard

# from the release tarball
dsh plugin --profile web add https://github.com/xine2009cn/dsh-branch-inbox-guard/releases/download/v0.1.0/dsh-branch-inbox-guard-0.1.0.tgz

# from a local file / directory
dsh plugin --profile web add ./dsh-branch-inbox-guard-0.1.0.tgz
```

Then restart DSH (`docker restart <container>`, or restart the app) and reload the Web GUI. The plugin
is a host-side bundle row, so a profile whose `dsh.profile.bundles` lists it will load it at boot.

## Verify it is working

Every time it drops something, the DSH log shows one line:

```text
[branch-inbox-guard] session-xxxxxxxx: dropped 5 inherited prompt(s) from its fork parent
```

End-to-end check: queue a message in a session while the agent is running, branch from a completed
turn, then look at the new branch — its queue should be empty, and a question typed there should start
running immediately.

## Uninstall

```bash
dsh plugin --profile web remove dsh-branch-inbox-guard
docker restart <container>
```

Nothing else is left behind: the plugin writes no files outside its own package, and never modifies
session history — the only thing it appends is the cancel event that removes the inherited items.

## Compatibility

Verified against DSH **0.1.5-rc.1** and **0.1.5-rc.2** (the versions whose inbox projection folds the
fork-inherited prefix). On **0.1.1-rc.2** the queue is already empty at fork time, so the plugin is a
no-op there.

It uses only documented faces: the `agent/created` event, `agent.inbox` (`nextTurn`, `nextStep`,
`clear`, `remove`), `session.inheritedEventCount`, `session.snapshotEvents()` and `session.id`.
If a future DSH release makes the inbox projection skip the inherited prefix again (i.e. fixes this
upstream), this plugin simply finds nothing to drop — and can be uninstalled.

## Tests

```bash
npm test        # or: node test/guard.test.mjs
```

Self-contained unit tests (no dependencies, no fixtures, no session data): mixed queue keeps the own
prompt and drops the inherited ones, a pure fork child gets a single durable `clear()`, inherited
steering input (`next-step`) is dropped, an unseeded session is untouched, an empty queue appends
nothing, a second run is a no-op, and an item with no traceable origin is kept.

## License

MIT
