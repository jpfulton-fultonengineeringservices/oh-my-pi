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

Because `memvidkb` is the default, a session that never set `memory.backend` gets the memory tools — `recall`, `retain`, `memory_search`, `memory_edit` and `memory_list` — instead of no memory at all. Nothing is contacted until the workspace's `.memvidkb` resolves: in a workspace without one, session start succeeds and each of those tools answers `knowledge_invalid_config: No .memvidkb configuration file found in workspace (code CONFIG_NOT_FOUND, workspace <dir>)`, so the operator gets an actionable error naming the workspace rather than a silent no-op or a call to a service nobody configured.

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context.

### Retired backends

`local`, `hindsight`, `mnemopi`, and `sharpshooter` are retired. The settings panel no longer offers them, and nothing is ever substituted for one: a retired id never resolves to a different store behind the operator's back.

A config left on a retired id migrates at load: `memory.backend` becomes `off`, the session boots with no memory subsystem, and startup logs a notice naming the retired id, what replaced it, and the two values to choose between. The load does not rewrite the file — the migrated value lives only in memory until a save is due, and a save writes it, so until something is saved the file still names the retired id and the notice repeats at each launch. What is still _refused_ is a retired id written at runtime — `/settings`, `set_command`, `omp config set` — which raises the actionable error naming the replacement instead of taking effect:

```yaml
memory:
   backend: memvidkb # or "off"
```

| Retired id     | Replaced by                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `local`        | memvid-kb-rs knowledge service; was the local `memory_summary.md` rollout-summarisation pipeline     |
| `hindsight`    | memvid-kb-rs knowledge service; nothing is deleted server-side, but omp no longer talks to Hindsight |
| `mnemopi`      | memvid-kb-rs knowledge service; was the local Mnemopi SQLite store (formerly `mnemosyne`)            |
| `sharpshooter` | memvid-kb-rs knowledge service; was the friction-gated project-decision store                        |

The retired implementations and their settings namespaces are still in the tree, pending a separate removal; they are unreachable through the selector, the settings panel, and the memory tools — the memory tools mount only for a live backend, so a retired id gets no `recall`, `retain`, `memory_search`, `memory_edit`, `memory_list` or `learn`. The settings enum still accepts the four retired ids so that an existing config loads instead of failing to parse; the value stays observable to a direct reader, and any retired id that reaches the selector is refused there, before a backend is constructed, with an actionable notice.

### `memories.enabled`

`memories.enabled` is accepted only as a migration input; `memory.backend` is the sole runtime selector. `memories.enabled: true` used to select `local`, so it now migrates to `off` and logs a startup notice naming the retired ids — switching on a network knowledge service nobody asked for is not the migration's to make. Neither migration rewrites the config at load, and neither rewrites it on an idle `flush()`; a save does, because a save re-reads the file through the same migration and writes the whole document back. So the migrated value reaches disk with the next save of **any** setting — saving `autolearn.enabled` lands `memory.backend: "off"` alongside it — and only a config nobody saves keeps naming the retired id, with the notice repeating at each launch.
