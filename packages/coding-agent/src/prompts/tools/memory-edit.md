Edit Mnemopi long-term memories by id. Only ids returned by `{{toolRefs.recall}}`.

Operations:
- `update`: working memory; replace content and/or importance.
- `forget`: permanently delete working memory.
- `invalidate`: softly supersede working or episodic memory; optional `replacement_id`.

{{#unless memvidkb}}Fact ids — `{{toolRefs.recall}}` results marked `[facts]`: read-only. Inspect with `read memory://<id>`; any edit op → `not_editable`.

{{/unless}}Prefer `invalidate` for stale memory whose history may still be useful. Use `forget` only for content requiring hard deletion.

MUST read full memory before `update`. Recall previews clipped: trailing `…` marks truncation; `full_length` original size. `update` replaces content wholesale → updating a preview deletes its unseen tail. First `read memory://<id>`; pass merged content in `content`.

{{#if memvidkb}}This backend is the central knowledge service, not Mnemopi: there is no fact tier. Every id it serves is an editable record in a track shared by every workspace bound to this context, and none of them is a row the caller may only look at. `{{toolRefs.recall}}` and `{{toolRefs.memory_list}}` return a clipped preview, and `read memory://<id>` resolves nothing here — the read that serves a record's full text and its `captured:` line is `read knowledge://record/<context>/<track>/<record-id>`.

`update` and `forget` both refuse with `precondition_failed`, sending nothing, unless `expected_captured_at` carries the value on the `captured:` line of the record you actually read. So read the record first, then resend with the value that read reported. A refusal naming a stale `captured:` value means the row changed underneath you: read it again rather than retrying the old value.

`forget` is irreversible: it erases the record and every chunk frame stored under its source uri, for every workspace bound to this context. `update` cannot be undone either — it supersedes the row with the text you supply, wholesale, so pass the merged text of the full read, never a preview.
{{/if}}
