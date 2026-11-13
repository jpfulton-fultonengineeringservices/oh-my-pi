# Fork changelog

Changes this fork carries on top of upstream `can1357/oh-my-pi`. Upstream's
`packages/*/CHANGELOG.md` files are kept verbatim, so a rebase onto a new
upstream tag never has to merge into them; fork-only entries live here instead.
Entries are oldest first, one per change, prefixed with the subsystem they touch.

- coding-agent/extensions: deferred extension loading now initializes native transcript presenter state and supports presenter registration/disposal and shortcut-conflict lookup through the supported factory API.
- coding-agent/tests: `test/rpc-wire/native-extension-smoke.ts` proves native extension discovery, mounted dispatch, independent MCP failure isolation and session switch/resume against the production binary, with every model, embedding, MCP and SSH call scripted locally.
- pi-ai: `applyProviderReportedCost` admits any provider when the wire echo carries a finite, non-negative `usage.cost`, and the BYOK `cost_details.upstream_inference_cost` fold is flag-driven rather than keyed to OpenRouter/ClinePass, so a gateway that reports an authoritative charge is no longer priced from token estimates.
- internal-urls: `knowledge://record/<context>/<track>/<id>` and `knowledge://track/<context>/<track>` resolve against the memvid-kb-rs record service. The workspace `.memvidkb` decides which context and which tracks a session may read, and both are checked before any network call; every refusal and outage is a non-empty explanation carrying a specific `notes` code, an outage is never reported as zero results, and a superseded or unproven record is never presented as current.
