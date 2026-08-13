# dsh-undo

Context undo/redo plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), inspired by the undo/redo experience in coding agents like [opencode](https://github.com/anomalyco/opencode).

The plugin adds two model-facing tools to every root agent:

- **`undo`** — rolls the model context back to the end of the last completed step. Every assistant message and tool result of that step is shadowed out of the visible context; the durable session log keeps every rolled-back event, so nothing is lost.
- **`redo`** — restores the messages the most recent `undo` removed, re-adding them to the context exactly as they were.

## How it works

The session log is append-only, so `undo` never deletes events. Instead it appends one **empty-content `assistant/message`** whose surface `replace` op shadows the target step's model-visible nodes. Empty assistant content derives to no message, so the context the model sees is exactly the pre-step context, while the log remains a complete, replayable, reversible history. `redo` re-appends fresh copies of the shadowed events as ordinary surface appends (with re-minted message identities; tool results keep their call correlation, so transcript tool-call → tool-result adjacency is preserved).

Design notes:

- **Undo unit is one completed step** (the newest step/end whose step still has visible messages). Repeated `undo` calls walk back one step at a time.
- **User messages are never rolled back** — a user prompt stays in context; only the assistant work done in response can be undone.
- **Redo is invalidated by new user input** — any new user-role message clears the redo stack (standard undo/redo semantics). The undo/redo tools' own calls, results, and redo copies do not invalidate it.
- **Durability** — every operation flushes through the shared session durability barrier (`ctx.sessions.flush`) before reporting success; if persistence cannot be proven, the tool returns `persistence_uncertain` rather than lying.
- **Undo history is process-local** — like a browser's undo stack, the redo stack is in memory. Restarting the process keeps the log consistent (markers stay shadowed, copies stay restored) but clears the redo stack.
- **Scope** — the tools are installed only for root agents published after the plugin loads (subagents and pre-existing sessions are not retrofitted).

## Install

The package is a [dsh bundle](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish/): `package.json` declares `dsh.bundle` pointing at `cordis.patch.yml`, which activates the plugin row.

From npm:

```sh
dsh plugin --profile demo add dsh-undo
```

From git (source checkout — the `prepare` script builds `lib/` on install; authorize the build in the profile's `pnpm-workspace.yaml` first):

```sh
dsh plugin --profile demo add github:LingLambda/dsh-undo#<sha>
```

For local development against a source checkout of deepseek-harness, load the plugin directly as an overlay:

```sh
pnpm dsh web --patch ./cordis.patch.yml --patch /absolute/path/to/dsh-undo/overlay.yml
```

where `overlay.yml` references the source entry:

```yaml
- insert:
    - id: undo
      name: /absolute/path/to/dsh-undo/src/index.ts
```

## Usage

The model calls `undo` when you ask it to undo, rewind, or roll back its latest action, and `redo` to restore what was undone:

```
> That edit was wrong. Undo it and try a different approach.
```

Each call's result reports what happened (`rolled_back` with the shadowed count and marker seq, `restored`, `nothing_to_undo`, `nothing_to_redo`, or an error).

## Develop

```sh
yarn install
yarn typecheck
yarn test
yarn build
```

## License

MIT
