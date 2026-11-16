# memory_list

Lists what long-term memory actually holds — a bounded inventory page, newest first, with no query involved.

`recall` answers a question about memory; `memory_list` answers "what is in there". Reach for it when you need a record's id, want to confirm a `retain` landed before writing it again, or are auditing who captured what and when.

## Availability

Offered only when `memory.backend` is `memvidkb`. The other backends have no listable store: `hindsight` and `mnemopi` expose no listing route, `local` is a file you can read with `read`, and `sharpshooter` writes nothing. Setting `memory.backend` to anything else hides the tool.

Like the rest of the memory tools it is `defaultState: "off"` in `BUILTIN_TOOL_HELP`, so a session that wants it names it explicitly in `--tools` / `tools` settings.

## Arguments

| Field    | Type     | Required | Description                                          |
| -------- | -------- | -------- | ---------------------------------------------------- |
| `limit`  | `number` | No       | Rows to return; defaults to 25 and is clamped to 200 |
| `offset` | `number` | No       | Rows to skip, for paging through a large track       |

## Behaviour

Sends `GET /api/v1/tracks/{track}/records?limit=…&offset=…&order=desc` against the knowledge service, where `{track}` is resolved from the `tracks` table in `.memvidkb`. Only reads are issued: no `POST`, no body.

Reads need the track to be reachable but **not** `consent.remember` — the two consent gates are separate by design. `consent.remember = "off"` blocks writes (`retain`, `learn`, `memory_edit`) and leaves this listing working, so an agent can always inspect what it is holding.

Rows carry identity and provenance, not full text: `id`, `captured=`, `verified=`, `origin=`, and optionally `title=`, `tags=`, `supersededBy=`, followed by a clipped preview. A preview ending in `…` is truncated — pull the whole record with `recall` or `read knowledge://record/<context>/<track>/<id>`.

## Output

```
3 records of 128 in fulton-infra-ecosystem:

- [1] id=mv2_rec_01 captured=2026-11-16T09:12:04Z verified=never origin=j.patrickfulton
  go2rtc exposes exactly two ONVIF services — Device and Media…
```

`of <total>` is omitted when the service does not report a total; `(from offset N)` appears when paging.

## Errors

A failed listing **throws**; it never degrades to an empty list, because "the service was unreachable" and "nothing was ever stored" must not read alike. Messages carry a stable `knowledge_*` prefix:

| Prefix                   | Meaning                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `knowledge_invalid_config` | `.memvidkb` absent, malformed, or has no usable track entry |
| `knowledge_unauthorized`   | token rejected; re-paste it in the console                  |
| `knowledge_forbidden`      | token is not a consumer token for this track                |
| `knowledge_unreachable`    | no route, connection refused, or timeout                    |
| `knowledge_unavailable`    | service unhealthy or migration in progress                  |
| `knowledge_not_found`      | the record or document you named does not exist             |

`No records stored in <track>.` is the only empty-looking output that means the track is genuinely empty.

Only ids returned by this tool or by `recall` may be passed to `memory_edit` — never invent an id.

## See also

- `recall` — ranked search, and the way to fetch a row's full text
- `retain` — writes a record; needs `consent.remember = "on"`
- `memory_edit` — update / forget by id
- `knowledge://` reader — read one record whole
