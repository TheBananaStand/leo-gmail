// Smoke test for the parsing — which is the whole of what this server can get
// wrong without anyone noticing.
//
// The Gmail calls are Google's to get right, and an auth failure is loud. What
// is silent is reading a label backwards, picking the wrong MIME part, or
// losing a message id in a history page: each produces a well-formed sync of
// wrong mail, and the first anyone notices is an inbox that looks wiped.
//
//   node test.js

process.env.LEO_GMAIL_MCP_NO_SERVE = "1";

const {
  headerMap,
  decodeBody,
  extractBody,
  flagsFromLabels,
  toMessage,
  idsFromHistory,
  labelEdits,
  missingRequired,
} = await import("./index.js");
const assert = await import("node:assert/strict");

const b64 = (s) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

// ── the two inversions ──────────────────────────────────────────────────────
// Gmail marks the ABSENCE of reading with UNREAD and the PRESENCE in the inbox
// with INBOX. Read either the obvious way round and every message syncs back
// unread and archived — a mailbox that looks wiped.
{
  assert.deepEqual(flagsFromLabels(["INBOX", "UNREAD"]), {
    is_read: false, is_starred: false, is_archived: false, is_trashed: false,
  });
  assert.deepEqual(flagsFromLabels(["INBOX"]), {
    is_read: true, is_starred: false, is_archived: false, is_trashed: false,
  });
  // No INBOX label at all is what "archived" means.
  assert.deepEqual(flagsFromLabels([]), {
    is_read: true, is_starred: false, is_archived: true, is_trashed: false,
  });
  assert.deepEqual(flagsFromLabels(["TRASH", "STARRED"]), {
    is_read: true, is_starred: true, is_archived: true, is_trashed: true,
  });
  // Never throws on junk — a malformed label list must not stop a sync.
  for (const junk of [undefined, null, "INBOX", 7, {}]) {
    assert.equal(flagsFromLabels(junk).is_read, true);
  }
}

// The same inversions on the way back out.
{
  assert.deepEqual(labelEdits({ read: true }),  { add: [], remove: ["UNREAD"] });
  assert.deepEqual(labelEdits({ read: false }), { add: ["UNREAD"], remove: [] });
  assert.deepEqual(labelEdits({ archived: true }),  { add: [], remove: ["INBOX"] });
  assert.deepEqual(labelEdits({ archived: false }), { add: ["INBOX"], remove: [] });
  assert.deepEqual(labelEdits({ starred: true }), { add: ["STARRED"], remove: [] });
  // Only what changed travels. `undefined` means "leave it" — sending it as
  // false would clear a flag the user never touched.
  assert.deepEqual(labelEdits({}), { add: [], remove: [] });
  assert.deepEqual(labelEdits({ trashed: true }), { add: [], remove: [] });
}

// ── headers ─────────────────────────────────────────────────────────────────
{
  const h = headerMap({
    payload: { headers: [
      { name: "From", value: "a@b" },
      { name: "SUBJECT", value: "Shouty" },   // case varies by sender
      { name: "X-Junk" },                      // no value
    ] },
  });
  assert.equal(h.from, "a@b");
  assert.equal(h.subject, "Shouty");
  assert.equal("x-junk" in h, false);
  assert.deepEqual(headerMap({}), {});
  assert.deepEqual(headerMap(null), {});
}

// ── base64url ───────────────────────────────────────────────────────────────
{
  assert.equal(decodeBody(b64("hello")), "hello");
  // Padding: Gmail strips it inconsistently, so all four residues must work.
  for (const s of ["a", "ab", "abc", "abcd", "hello world!"]) {
    assert.equal(decodeBody(b64(s)), s);
  }
  // The URL alphabet really is different — a body with + or / in standard b64
  // becomes - and _ here, and decoding it as standard b64 yields mojibake.
  assert.equal(decodeBody(b64("~~~???")), "~~~???");
  assert.equal(decodeBody(""), "");
  assert.equal(decodeBody(undefined), "");
}

// ── MIME walk ───────────────────────────────────────────────────────────────
{
  // HTML wins over plain: it is what the reading pane renders, and the plain
  // part of a multipart/alternative is a lossy fallback nobody should see.
  const alternative = { payload: { mimeType: "multipart/alternative", parts: [
    { mimeType: "text/plain", body: { data: b64("plain") } },
    { mimeType: "text/html",  body: { data: b64("<p>rich</p>") } },
  ] } };
  assert.deepEqual(extractBody(alternative), {
    text: "<p>rich</p>", contentType: "text/html",
  });

  // Plain-only stays plain.
  const plainOnly = { payload: { mimeType: "text/plain", body: { data: b64("just text") } } };
  assert.deepEqual(extractBody(plainOnly), { text: "just text", contentType: "text/plain" });

  // multipart/mixed with an attachment nests the real body a level down, so
  // the walk has to recurse — a flat scan finds nothing here.
  const mixed = { payload: { mimeType: "multipart/mixed", parts: [
    { mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { data: b64("nested") } },
    ] },
    { mimeType: "application/pdf", filename: "x.pdf", body: { attachmentId: "abc" } },
  ] } };
  assert.deepEqual(extractBody(mixed), { text: "nested", contentType: "text/plain" });

  // Nothing found is text/plain and empty — never a guess of HTML, which would
  // render escaped markup into the pane.
  assert.deepEqual(extractBody({}), { text: "", contentType: "text/plain" });
  assert.deepEqual(extractBody({ payload: { parts: [] } }), {
    text: "", contentType: "text/plain",
  });
}

// ── whole message ───────────────────────────────────────────────────────────
{
  const m = toMessage({
    id: "m1",
    threadId: "t1",
    snippet: "hi there",
    sizeEstimate: 2048,
    labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
    payload: {
      headers: [
        { name: "From", value: "Ada <ada@example.com>" },
        { name: "To", value: "me@example.com" },
        { name: "Subject", value: "Lunch?" },
        { name: "Date", value: "Wed, 27 Aug 2026 10:00:00 -0700" },
      ],
      mimeType: "text/plain",
      body: { data: b64("one o'clock") },
    },
  });
  assert.equal(m.external_id, "m1");
  assert.equal(m.thread_id, "t1");
  assert.equal(m.from_addr, "Ada <ada@example.com>");
  assert.equal(m.subject, "Lunch?");
  assert.equal(m.body, "one o'clock");
  assert.equal(m.body_content_type, "text/plain");
  // The RFC-2822 header verbatim; the hub parses it into a sortable epoch, so
  // reformatting it here would break that parse.
  assert.equal(m.date, "Wed, 27 Aug 2026 10:00:00 -0700");
  assert.deepEqual(m.labels, ["INBOX", "UNREAD", "IMPORTANT"]);
  assert.equal(m.is_read, false);
  assert.equal(m.is_archived, false);
  assert.equal(m.raw_size, 2048);

  // A sparse message must still produce every field the contract names, with
  // the column defaults — the hub upserts these straight in.
  const sparse = toMessage({ id: "m2" });
  assert.equal(sparse.external_id, "m2");
  assert.equal(sparse.thread_id, undefined);
  assert.equal(sparse.from_addr, "");
  assert.equal(sparse.body_content_type, "text/plain");
  assert.deepEqual(sparse.labels, []);
  assert.equal(sparse.raw_size, 0);
}

// ── history pages ───────────────────────────────────────────────────────────
{
  const page = { history: [
    { messagesAdded:  [{ message: { id: "a" } }] },
    { labelsAdded:    [{ message: { id: "a" } }, { message: { id: "b" } }] },
    { labelsRemoved:  [{ message: { id: "c" } }] },
    { messagesDeleted:[{ message: { id: "d" } }] },
  ] };
  const { changed, deleted } = idsFromHistory(page);
  // "a" appears twice and must be fetched once.
  assert.deepEqual(changed.sort(), ["a", "b", "c"]);
  assert.deepEqual(deleted, ["d"]);
}

{
  // A message changed and then deleted in the same window is deleted, full
  // stop — fetching it is a guaranteed 404.
  const page = { history: [
    { labelsAdded:     [{ message: { id: "x" } }] },
    { messagesDeleted: [{ message: { id: "x" } }] },
  ] };
  const { changed, deleted } = idsFromHistory(page);
  assert.deepEqual(changed, []);
  assert.deepEqual(deleted, ["x"]);
}

{
  // An empty or malformed page is "nothing changed", not a crash.
  for (const junk of [{}, { history: [] }, { history: null }, null, undefined]) {
    assert.deepEqual(idsFromHistory(junk), { changed: [], deleted: [] });
  }
}

// ── required params ─────────────────────────────────────────────────────────
{
  assert.deepEqual(missingRequired("sync_user", {}).sort(), ["access_token", "user_id"]);
  assert.deepEqual(missingRequired("sync_user", { user_id: "u", access_token: "t" }), []);
  // cursor is optional — a first sync has none.
  assert.deepEqual(missingRequired("sync_user", { user_id: "u", access_token: "t", cursor: undefined }), []);
  assert.deepEqual(
    missingRequired("modify_flags", { user_id: "u" }).sort(),
    ["access_token", "external_id"],
  );
}

console.log("ok — label inversions, MIME walk and history de-duplication hold");
