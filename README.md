# context-mode for DSH

`dsh-context-mode` exposes a self-contained context-mode server as native
DeepSeek Harness tools. It registers the full `ctx_*` catalog at runtime and
adds model-facing routing guidance, so dsh-TUI can use sandboxed execution,
indexing, FTS5 retrieval, and web fetching without a second MCP client.

The engine is vendored: `vendor/context-mode/` carries the source and this
package builds its own `server.bundle.mjs` from it. There is **no `context-mode`
npm dependency** at runtime, and the eighteen upstream platform adapters
(Claude Code, Codex, Cursor, Gemini CLI, …) were removed — DSH is the only
supported host.

Two DSH-specific changes sit on top of the vendored engine:

- **CJK search.** Upstream indexes with `porter unicode61` and `trigram`, so
  Chinese queries largely fail (a run of Han characters becomes one token, and
  the trigram table cannot match two-character words). The adapter segments CJK
  text on both sides of the index, which took a five-query Chinese benchmark
  from 2/5 to 5/5.
- **Output containment.** Results above 40 KB are truncated to head + tail, the
  full text is spilled to disk, and the model is told how to read it back.

See [`LICENSING.md`](./LICENSING.md): the adapter is MIT, the vendored engine is
Elastic License 2.0.

## Install

```sh
dsh plugin --profile dsh-tui add dsh-context-mode
```

Restart the profile after installation. Removing the package removes its profile
row as well:

```sh
dsh plugin --profile dsh-tui remove dsh-context-mode
```

The npm package ships a prebuilt `vendor/context-mode/server.bundle.mjs`, so no
build step runs at install time. The bundled `skills/context-mode/SKILL.md` is
registered with DSH's skill registry when the profile provides the `skills`
service, so it should appear in `/skills` after a restart.

## Configuration

The default patch starts the bridge with:

- `enabled: true`
- the installed `context-mode/server.bundle.mjs`
- the current working directory as the project directory
- `~/.dsh/context-mode` as the isolated database root
- a 60-second initialize and tool-catalog timeout

Override the row's `config` in a profile patch when needed:

```yaml
- id: dsh-context-mode
  name: dsh-context-mode
  inject: [tools, systemPrompt]
  config:
    projectDir: /absolute/path/to/worktree
    storageDir: /absolute/path/to/context-mode-data
    handshakeTimeoutMs: 120000
```

`serverPath` is available for local development and pinned deployments. It may
be an absolute path or a path relative to the profile process directory.

## Runtime behavior

The plugin starts one long-lived child process per DSH composition. It performs
MCP `initialize` and `tools/list`, registers each returned tool through the DSH
tool registry, and forwards every call over MCP stdio. The child is terminated
when the Cordis plugin is disposed.

Context-mode analysis, indexing, search, and diagnostics tools are marked concurrency-safe so independent model tool calls may overlap. `ctx_insight`, `ctx_purge`, and `ctx_upgrade` remain exclusive because they open external UI or mutate installation and stored data.
`ctx_batch_execute` additionally parallelizes its own command batch through its `concurrency` parameter.

All eleven `ctx_*` capabilities are exposed on DSH — `ctx_execute`,
`ctx_execute_file`, `ctx_batch_execute`, `ctx_fetch_and_index`, `ctx_index`,
`ctx_search`, `ctx_stats`, `ctx_doctor`, `ctx_upgrade`, `ctx_purge`, and
`ctx_insight`. Each registered tool carries DSH-specific routing guidance in its
description, and the plugin injects a routing section plus a bundled
`context-mode` skill so the model reaches for these tools by default.

The adapter targets DSH only. Cross-platform code you may see inside the
`context-mode` dependency belongs to that package's prebuilt MCP server, which
this adapter does not modify; it ships no Claude Code, Codex, or other host
integration of its own. `CONTEXT_MODE_PLATFORM=pi` is set solely because upstream
only accepts its own platform ids, and `pi` is its neutral MCP-only id — every
store stays DSH-owned: `CONTEXT_MODE_DIR` isolates DSH data and
`CONTEXT_MODE_PROJECT_DIR` pins project hashing to the configured workspace.

## Compaction archiving

Compaction replaces the live conversation with a generated summary and prunes
the events behind it, so anything the summary omits leaves the model's reach.
The plugin listens for `compaction/start` and files the transcript into the
knowledge base first, where `ctx_search` can still reach it afterwards.

Storage is layered rather than filtered — every transcript event is archived,
and the layers differ only in the `source` label they carry, so precision is
chosen at query time instead of at write time:

| Source | Contents |
| --- | --- |
| `session/<id>/constraint` | user messages — requirements, decisions, limits |
| `session/<id>/finding` | tool results and assistant prose stating a concrete value |
| `session/<id>/narrative` | remaining assistant prose — reasoning, plans |

Nothing is dropped at write, so a misclassification costs a query's precision
rather than the content itself. Harness-injected blocks (`<active_memory>`,
`<current_runtime_context>`, `<system-reminder>`, `<resume_snapshot>`) are the
one exception: they ride on `user/message`, are per-turn runtime noise rather
than transcript, and are discarded before layering. Set `precompact: false` to
turn archiving off entirely.

Archives written before 0.3.2 may contain those injected blocks. A one-shot
cleanup script removes them and leaves everything else alone:

```sh
node node_modules/dsh-context-mode/scripts/cleanup-injected.mjs --db <path>            # report only
node node_modules/dsh-context-mode/scripts/cleanup-injected.mjs --db <path> --apply    # delete
```

## Checkpoint transcript and archive index

A checkpoint keeps only a summary of the span it replaces, and the shipped
checkpoint format has no section for tool output — a long tool result survives
only as whatever the summarizing model chose to keep. `precompact` files that
same span into the knowledge base beforehand, but nothing told the model so,
and a summary that omits a detail reads as if the detail never existed.

Closing that gap is a **separate product**, not part of this package:

```sh
npm install dsh-context-mode-compaction
npx dsh-context-mode-compaction
```

`dsh-context-mode-compaction` supplies the compaction engine that writes the
transcript and the index; this package supplies the archiver that stores what
those pointers name, and the `ctx_search` tool that reads it back. The two are
independent — install both for the full path.

See [dsh-context-mode-compaction](https://www.npmjs.com/package/dsh-context-mode-compaction)
for the checkpoint format, the tuning constants, and the preset wiring.

## Development

```sh
pnpm install
pnpm build
```

The plugin needs Node `^22.19 || >=24`. The upstream package installs
`better-sqlite3`; a native build may be required on platforms without a
prebuilt binary.

## License

MIT for this adapter. The runtime dependency keeps its own license and terms;
see the upstream `context-mode` package.
