# context-mode for DSH

`dsh-context-mode` exposes the upstream `context-mode` MCP server as native
DeepSeek Harness tools. It registers the full `ctx_*` catalog at runtime and
adds model-facing routing guidance, so dsh-TUI can use sandboxed execution,
indexing, FTS5 retrieval, and web fetching without a second MCP client.

The upstream package remains a runtime dependency. This adapter does not copy
or fork its server implementation.

## Install

```sh
dsh plugin --profile dsh-tui add dsh-context-mode
```

Restart the profile after installation. Removing the package removes its profile
row as well:

```sh
dsh plugin --profile dsh-tui remove dsh-context-mode
```

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

The bridge sets `CONTEXT_MODE_PLATFORM=pi` for compatibility with context-mode's
existing adapter defaults, while `CONTEXT_MODE_DIR` keeps DSH data separate from
Pi and Claude Code data. `CONTEXT_MODE_PROJECT_DIR` pins project hashing to the
configured workspace.

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
