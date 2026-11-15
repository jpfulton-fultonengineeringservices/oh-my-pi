# Changelog

## [Unreleased]

### Added

- Added `@oh-my-pi/pi-tavily`: the fork's single Tavily client, so the built-in
  `web_search` provider and the agent-facing `tavily_*` tools stop each keeping their
  own idea of Tavily's wire. Ships `createTavilyClient`, the six verbs
  (`tavilySearch`, `tavilyExtract`, `tavilyCrawl`, `tavilyMap`, `tavilyResearch`,
  `tavilyResearchStatus`) plus the streaming variant `tavilyResearchStream`,
  `TAVILY_TOOL_SPECS`, and
  `classifyTavilyError` / `TavilyError`.
- Added the `apiBaseURL` request override, which upstream `@tavily/core` does not
  expose per request. It is what lets the test suite point a real axios transport at a
  local `node:http` server instead of `api.tavily.com`; `adapter` is the companion
  seam.
- Added `TAVILY_TOOL_SPECS` as zod-free data: verb descriptions, field types, enums
  and bounds in one place, so a consumer builds `pi.zod` schemas without importing a
  second zod and a second set of descriptions. It deliberately omits transport-only
  and caller-owned fields (`apiKey`, `signal`, `timeoutSeconds`, `apiBaseURL`) and the
  caller-side `engine` selector.
- Added per-verb request timeouts (`search` 60s, `extract` 30s, `crawl`/`map` 150s,
  `research_status` 60s) where the transport defaults to 60s for everything and
  `research` to none, and an `AbortSignal` race that never leaves a call hanging on a
  request that will not answer.
- Added keyless gating: a client with no API key answers `search` and `extract`, and
  resolves the other four verbs to an `auth` failure naming the `apiKey` option
  without sending anything, mirroring the SDK's own guard with a message a model can
  act on.
- Added the `timeout` parameter to `tavilyResearch` and `tavilyResearchStream` as the
  client-side HTTP budget — the name the tool table advertises — alongside the
  `timeoutSeconds` every other verb uses. `/research` has no server-side timeout, so
  it is never sent in the body, and `timeoutSeconds` wins when both are given.
- Added `plan-limit` and `unknown` to `TavilyErrorCode`. The cap class is a subclass of
  `TavilyRequestError` and the API raises it for several statuses — 429 alongside 401
  `api_key_required`, 403 `abuse_blocked`, 404 `unsupported_endpoint` and 503
  `service_unavailable` — so `classifyTavilyError` tests it before the parent class and
  a capped 401 is reported as a cap, not as an auth failure. A plain (non-envelope) 432
  gets `plan-limit` rather than borrowing the documented 429 `rate-limit` meaning, and
  a value with nothing identifiable in it gets `unknown` instead of being called a
  transport error.
