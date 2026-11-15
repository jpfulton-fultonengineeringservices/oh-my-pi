# @oh-my-pi/pi-tavily

The fork's single [Tavily](https://tavily.com) client: one place that knows the wire
(`api.tavily.com`, snake_case bodies, header identity, error envelopes) so that every
consumer — the built-in `web_search` provider and the agent-facing `tavily_*` tools
alike — issues the same request and renders the same failure.

Everything here is transport and data. No zod, no terminal, no policy: the tool
surface is exported as plain data so a caller builds schemas with its own validator.

## Modules

| Module       | Purpose                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `client`     | `createTavilyClient` — key, identity headers, proxy, per-request `timeoutSeconds`/`adapter`/`apiBaseURL`; `tavilyKeyAvailable` |
| `verbs`      | `tavilySearch` / `Extract` / `Crawl` / `Map` / `Research` / `ResearchStatus`, plus `tavilyResearchStream` for live streaming    |
| `wire`       | The one request-body builder (`buildSearchBody`) and the response normalisers                                                    |
| `specs`      | `TAVILY_TOOL_SPECS` — each verb's description and field schema as data                                                           |
| `errors`     | `classifyTavilyError`, `TavilyError`, `tavilyAborted`                                                                             |
| `types`      | Result shapes, `TavilyResult<T> = { ok: true; data } \| { ok: false; error }`, the transport seam                                |

Import from the root barrel or per-module subpaths (`@oh-my-pi/pi-tavily/<module>`).

## Usage

```ts
import { createTavilyClient, tavilySearch } from "@oh-my-pi/pi-tavily";

const client = createTavilyClient(); // key from TAVILY_API_KEY

const result = await tavilySearch(client, { query: "bun http adapter", searchDepth: "advanced" });
if (!result.ok) {
	// Never throws: a missing key, a 429 and a dead socket all land here with a code.
	console.warn(`${result.error.code}: ${result.error.message}`);
} else {
	for (const doc of result.data.results) console.log(doc.title, doc.url);
}
```

Three rules the surface is built on:

- **Verbs resolve, they do not throw.** Every failure is a `TavilyFailure`
  (`auth`, `keyless-limit`, `plan-limit`, `rate-limit`, `timeout`, `bad-request`,
  `transport`, `aborted`, `unknown`)
  carrying a bounded `detail`, so a tool can hand it to a model as guidance.
- **A keyless client is not an error at the boundary.** Keyless Tavily serves only
  `search` and `extract`; the other verbs resolve to an `auth` failure naming the
  `apiKey` option instead of sending a request the API would reject.
- **`research` is polled, never awaited silently.** `tavilyResearch` submits and
  `tavilyResearchStatus` reads; `tavilyResearchStream` yields one `TavilyResearchChunk`
  per event and carries a terminal failure on that chunk's `error` field rather than
  swallowing it or throwing.

## Install

```sh
bun add @oh-my-pi/pi-tavily
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.4.4. Talks to
Tavily through `@tavily/core`'s axios transport, so this is a Node/Bun package, not a
browser one.

## Testing

`bun test` starts a local `node:http` server on an ephemeral port and points the real
transport at it via `apiBaseURL` — no network, no recorded fixtures.

## References

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [CHANGELOG](./CHANGELOG.md)
