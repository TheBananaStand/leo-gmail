# leo-gmail

Gmail as a Leo **mail provider**, over MCP — sync into the Inbox, and
write-through of read / starred / archived / trashed back to Gmail.

This fills the `mail` provider role (`leo_mcp::providers`), which is what lets a
mail provider live outside the hub's binary at all. It replaces the compiled
`leo-gmail` package.

## The contract

| Tool | Arguments | Returns |
|---|---|---|
| `sync_user` | `{user_id, access_token, cursor?}` | `{messages: [...], cursor?}` |
| `modify_flags` | `{user_id, external_id, access_token, flags}` | `{}` |

## Two things this deliberately does not do

**It does not touch a database.** The hub writes what `sync_user` returns into
`email_messages` itself — the same split as the `wallpaper` role, where the
server returns photos and the gallery stores them. That is what keeps the schema
private: a provider returning rows for a table it could see would be coupled to
every migration of it.

**It does not own an OAuth app.** The hub already holds your Google grant and
its refresh token, so it mints a short-lived access token and passes it per
call. The alternative — this package carrying its own client id and consent
screen — would ask you to authorize an account you had already connected.

## The package name is load-bearing

The entry is named `gmail`, not `gmail-mcp`, because **the package name is the
`email_messages.source`** the hub keys mail under. Existing mail on a hub is
`source = 'gmail'`; publishing under any other name would orphan every message
already synced and start a second, parallel mailbox.

## Sync

First sync fetches the most recent mail and nothing older. After that it is
incremental, resuming from the cursor the hub stored — which is *the hub's*
cursor, held in `email_sync_state` across restarts and reinstalls, so
reinstalling this package does not silently trigger a full re-sync.

The cursor for the *next* pass is read **before** the fetch. Read after, a
message arriving mid-sync would sit before a cursor that had already passed it,
and would never be seen again.

Gmail expires history older than about a week and answers `404`. That is not a
failure — it is "you have been away too long" — so it falls back to a full pass
rather than leaving the account permanently unsyncable.

## Development

```bash
npm install
node test.js        # no network needed
```

The test covers what fails *quietly*, because an auth failure is loud and a
misparse is not:

- **The two label inversions.** Gmail marks the *absence* of reading with
  `UNREAD` and the *presence* in the inbox with `INBOX`. Read either the obvious
  way round and every message syncs back unread and archived — a mailbox that
  looks wiped.
- **The MIME walk.** HTML is preferred over plain (it is what the reading pane
  renders); a `multipart/mixed` with an attachment nests the real body a level
  down, so a flat scan finds nothing; and nothing-found is `text/plain`, never a
  guess of HTML, which would render escaped markup into the pane.
- **base64url.** Gmail strips padding inconsistently and uses the URL alphabet,
  so decoding as standard base64 yields mojibake.
- **History de-duplication.** One id can appear under several change types and
  across pages; a message deleted in the same window it changed is deleted, full
  stop, because fetching it is a guaranteed 404.

## Publishing

```bash
./store/publish.sh          # live
./store/publish.sh draft    # stage for review at admin.leoconnect.io
```

Needs a Cloudflare login with `D1:Edit` on the `leo-store` database.

> **Not publishable until the compiled `leo-gmail` package leaves the hub's
> build.** Two packages cannot share a name, and the name here is deliberate
> (see above).
