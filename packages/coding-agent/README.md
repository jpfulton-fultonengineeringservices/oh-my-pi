# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `omp` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:

- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:

- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Bash visualization

Embedded-shell calls default to Python-like **Pseudo**; switch to **Raw** for the original command. Syntax appears incrementally as the shell compiles it. Active commands retain their colors while inactive code fades; only failures get `×`. Values appear beside each variable's latest observed setter.

In Tern, the toggle and menu stay in the command segment; replay controls live in the inspector. In the inspector, `v` toggles Raw/Pseudo; `c/i/d/e/u` toggle color, inline variables, idioms, effects and embedded programs; `s` splits original/Pseudo. Space plays or pauses retained execution, arrows step, `r` resets, `l` returns live, and `−/+` changes speed. Escape closes.

Replay retains up to 20,000 records, 2 MiB output and 8 MiB payload; evictions are indicated. Effect badges are heuristic, not safety guarantees. Remote-script interiors are marked untraced; PTY/user-shell calls keep their plain command view.

## Memory backends

Memory is selected by one setting, `memory.backend` (Settings → Memory tab, or `~/.omp/config.yml`). Two values are selectable:

- `memvidkb` (default) — the central memvid-kb-rs knowledge service, addressed through the workspace's `.memvidkb` (endpoint plus bearer token). Nothing is contacted until that file resolves, so an embedder never reaches a knowledge service it did not opt into.
- `off` — no memory subsystem runs.

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context.

### Retired backends

`local`, `hindsight`, `mnemopi`, and `sharpshooter` are retired. The selector refuses a retired id with an error naming what replaced it rather than falling back to a different store, and the settings panel no longer offers them. A session started from a config left on a retired id fails to start with that error, so the operator is told to change the setting instead of silently running a different store:

```yaml
memory:
  backend: memvidkb # or "off"
```

| Retired id     | Replaced by                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `local`        | memvid-kb-rs knowledge service; was the local `memory_summary.md` rollout-summarisation pipeline             |
| `hindsight`    | memvid-kb-rs knowledge service; nothing is deleted server-side, but omp no longer talks to Hindsight         |
| `mnemopi`      | memvid-kb-rs knowledge service; was the local Mnemopi SQLite store (formerly `mnemosyne`)                     |
| `sharpshooter` | memvid-kb-rs knowledge service; was the friction-gated project-decision store                                 |

The retired implementations and their settings namespaces are still in the tree, pending a separate removal; they are unreachable through the selector, the settings panel, and the memory tools.

### `memories.enabled`

`memories.enabled` is accepted only as a migration input; `memory.backend` is the sole runtime selector. `memories.enabled: true` used to select `local`, so it now migrates to `off` and logs a startup notice naming the retired ids — switching on a network knowledge service nobody asked for is not the migration's to make. Migration does not rewrite the config by itself; the first time any other setting is saved, the migrated value is written with it. Until one of those happens the notice repeats at each launch.
