List what long-term memory actually holds, newest page first, without searching for anything.

`{{toolRefs.recall}}` answers a question; `{{toolRefs.memory_list}}` answers "what exists". Use it to audit a track, find a record whose id you never recalled, or check that a `{{toolRefs.retain}}` landed before re-writing it.

Rows carry `id`, capture time, last-verified time, producing actor, and a clipped preview — never the full text. `…` at the end of a preview means truncation; fetch the whole record with `{{toolRefs.recall}}` or `read knowledge://record/<context>/<track>/<id>`.

Only ids this listing or a `{{toolRefs.recall}}` returned may be passed to `{{toolRefs.memory_edit}}`. An empty listing with a `knowledge_*` reason in its message is an outage or a refusal, not an empty store — never conclude "nothing was stored" from one.
