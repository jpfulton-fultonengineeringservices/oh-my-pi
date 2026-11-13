# Fork changelog

Changes this fork carries on top of upstream `can1357/oh-my-pi`. Upstream's
`packages/*/CHANGELOG.md` files are kept verbatim, so a rebase onto a new
upstream tag never has to merge into them; fork-only entries live here instead.
Entries are oldest first, one per change, prefixed with the subsystem they touch.

- coding-agent/extensions: deferred extension loading now initializes native transcript presenter state and supports presenter registration/disposal and shortcut-conflict lookup through the supported factory API.
- coding-agent/tests: `test/rpc-wire/native-extension-smoke.ts` proves native extension discovery, mounted dispatch, independent MCP failure isolation and session switch/resume against the production binary, with every model, embedding, MCP and SSH call scripted locally.
