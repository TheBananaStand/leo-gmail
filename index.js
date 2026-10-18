#!/usr/bin/env node
//
// Gmail as a Leo mail provider, over MCP.
//
// This fills the `mail` provider role (`leo_mcp::providers`), which is what
// lets a mail provider live outside the hub's binary at all. The contract:
//
//   sync_user({user_id, access_token, cursor?}) -> {messages: [...], cursor?}
//   modify_flags({user_id, external_id, access_token, flags}) -> {}
//
// TWO THINGS THIS SERVER DELIBERATELY DOES NOT DO.
//
// It does not touch a database. The hub writes what this returns into
// `email_messages` itself — same split as the `wallpaper` role, where the
// server returns photos and the gallery stores them. That is what keeps the
// schema private: a provider returning rows for a table it could see would be
// coupled to every migration of it.
//
// It does not own an OAuth app. The hub already holds the user's Google grant
// and its refresh token, so it mints a short-lived access token and passes it
// per call. The alternative — this package carrying its own client id and
// consent screen — would ask the owner to authorize an account they had
// already connected.
//
// Plain JavaScript on purpose: this ships as a git tarball, and npm does not
// reliably run build steps for a tarball URL.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Gmail caps a list page at 500; 50 is what the compiled package used. */
const PAGE = 50;
/** How many messages one incremental pass will fetch before stopping. */
const MAX_PER_SYNC = 200;

// ---------------------------------------------------------------------------
// Parsing — everything below is pure, and is where this server can be wrong
// ---------------------------------------------------------------------------

/** Gmail's headers arrive as a list of {name, value}; case varies by sender. */
export function headerMap(message) {
  const out = {};
  const list = message?.payload?.headers;
  if (!Array.isArray(list)) return out;
  for (const h of list) {
    if (typeof h?.name === "string" && typeof h?.value === "string") {
      out[h.name.toLowerCase()] = h.value;
    }
  }
  return out;
}

/** base64url -> text. Gmail pads inconsistently, so padding is restored. */
export function decodeBody(data) {
  if (typeof data !== "string" || data === "") return "";
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Walk the MIME tree for a body, preferring HTML over plain text.
 *
 * HTML first because that is what the reading pane renders and what the sender
 * laid out; the plain part of a multipart/alternative is a lossy fallback the
 * sender expects nobody to see. Depth-first over `parts`, because a
 * multipart/mixed with an attachment nests the real body one level down.
 *
 * Returns `{text, contentType}` — `text/plain` when nothing was found, which is
 * the column's default and never a guess of HTML (guessing HTML renders escaped
 * markup into the pane).
 */
export function extractBody(message) {
  const found = { html: undefined, plain: undefined };

  const walk = (part) => {
    if (!part || typeof part !== "object") return;
    const mime = typeof part.mimeType === "string" ? part.mimeType : "";
    const data = part.body?.data;
    if (typeof data === "string" && data !== "") {
      if (mime === "text/html" && found.html === undefined) {
        found.html = decodeBody(data);
      } else if (mime === "text/plain" && found.plain === undefined) {
        found.plain = decodeBody(data);
      }
    }
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  };
  walk(message?.payload);

  if (found.html !== undefined) return { text: found.html, contentType: "text/html" };
  if (found.plain !== undefined) return { text: found.plain, contentType: "text/plain" };
  return { text: "", contentType: "text/plain" };
}

/**
 * Gmail labels -> the hub's four flags.
 *
 * TWO OF THESE ARE INVERTED, and that is the whole of what can go quietly
 * wrong here: Gmail marks the *absence* of reading with `UNREAD`, and the
 * *presence* in the inbox with `INBOX`. Read them the obvious way round and
 * every message syncs back unread and archived — a mailbox that looks wiped.
 */
export function flagsFromLabels(labels) {
  const has = (l) => Array.isArray(labels) && labels.includes(l);
  return {
    is_read: !has("UNREAD"),
    is_starred: has("STARRED"),
    is_archived: !has("INBOX"),
    is_trashed: has("TRASH"),
  };
}

/** One Gmail message -> the `mail` role's message shape. */
export function toMessage(message) {
  const h = headerMap(message);
  const labels = Array.isArray(message?.labelIds) ? message.labelIds : [];
  const body = extractBody(message);
  return {
    external_id: typeof message?.id === "string" ? message.id : "",
    thread_id: typeof message?.threadId === "string" ? message.threadId : undefined,
    from_addr: h.from ?? "",
    to_addr: h.to ?? "",
    subject: h.subject ?? "",
    snippet: typeof message?.snippet === "string" ? message.snippet : "",
    body: body.text,
    body_content_type: body.contentType,
    // The RFC-2822 header verbatim; the hub parses it into a sortable epoch.
    date: h.date ?? "",
    labels,
    ...flagsFromLabels(labels),
    raw_size: Number.isFinite(message?.sizeEstimate) ? message.sizeEstimate : 0,
  };
}

/**
 * The message ids a history page implies.
 *
 * A history record can name the same id under several types, and the same id
 * can appear across pages — so this de-duplicates. `messagesDeleted` is
 * reported separately because a deleted message cannot be fetched: asking for
 * it is a guaranteed 404, and a sync that treats that as a failure stops.
 */
export function idsFromHistory(page) {
  const changed = new Set();
  const deleted = new Set();
  for (const record of page?.history ?? []) {
    for (const key of ["messagesAdded", "labelsAdded", "labelsRemoved"]) {
      for (const entry of record?.[key] ?? []) {
        const id = entry?.message?.id;
        if (typeof id === "string") changed.add(id);
      }
    }
    for (const entry of record?.messagesDeleted ?? []) {
      const id = entry?.message?.id;
      if (typeof id === "string") deleted.add(id);
    }
  }
  // A message deleted in the same window it changed is deleted, full stop.
  for (const id of deleted) changed.delete(id);
  return { changed: [...changed], deleted: [...deleted] };
}

// ---------------------------------------------------------------------------
// Gmail calls
// ---------------------------------------------------------------------------

async function gmail(token, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const err = new Error(`Gmail API ${response.status}: ${detail.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }
  const text = await response.text();
  return text === "" ? {} : JSON.parse(text);
}

/** The account's current history id — the cursor a later sync resumes from. */
async function currentHistoryId(token) {
  const profile = await gmail(token, "/profile");
  return typeof profile.historyId === "string" ? profile.historyId : undefined;
}

async function fetchFull(token, id) {
  try {
    return await gmail(token, `/messages/${encodeURIComponent(id)}?format=full`);
  } catch (e) {
    // A message deleted between being listed and being fetched is normal, not
    // a failure — dropping it beats aborting a sync of two hundred others.
    if (e.status === 404) return undefined;
    throw e;
  }
}

/** First sync for an account: the most recent page of mail, nothing older. */
async function initialSync(token) {
  const messages = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ maxResults: String(PAGE) });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await gmail(token, `/messages?${q}`);
    for (const stub of page.messages ?? []) {
      if (messages.length >= MAX_PER_SYNC) break;
      const full = await fetchFull(token, stub.id);
      if (full) messages.push(toMessage(full));
    }
    pageToken = messages.length < MAX_PER_SYNC ? page.nextPageToken : undefined;
  } while (pageToken);
  return messages;
}

/** Everything that changed since `cursor`. */
async function incrementalSync(token, cursor) {
  const changedIds = new Set();
  let pageToken;
  do {
    const q = new URLSearchParams({ startHistoryId: cursor });
    for (const t of ["messageAdded", "labelAdded", "labelRemoved", "messageDeleted"]) {
      q.append("historyTypes", t);
    }
    if (pageToken) q.set("pageToken", pageToken);

    const page = await gmail(token, `/history?${q}`);
    const { changed } = idsFromHistory(page);
    changed.forEach((id) => changedIds.add(id));
    pageToken = changedIds.size < MAX_PER_SYNC ? page.nextPageToken : undefined;
  } while (pageToken);

  const messages = [];
  for (const id of changedIds) {
    const full = await fetchFull(token, id);
    if (full) messages.push(toMessage(full));
  }
  return messages;
}

/** Gmail's label edits for a flag change. Inverted for read and archived. */
export function labelEdits(flags = {}) {
  const add = [];
  const remove = [];
  if (flags.read === true) remove.push("UNREAD");
  if (flags.read === false) add.push("UNREAD");
  if (flags.starred === true) add.push("STARRED");
  if (flags.starred === false) remove.push("STARRED");
  if (flags.archived === true) remove.push("INBOX");
  if (flags.archived === false) add.push("INBOX");
  return { add, remove };
}

const TOOLS = {
  sync_user: {
    description:
      "Fetch mail for one user. Returns messages and a cursor to resume from.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        access_token: { type: "string" },
        cursor: { type: "string" },
      },
      required: ["user_id", "access_token"],
    },
    run: async ({ access_token, cursor }) => {
      // The next cursor is read BEFORE the fetch. Read after, any message that
      // arrived mid-sync sits before a cursor that has already passed it, and
      // is never seen again.
      const next = await currentHistoryId(access_token);
      let messages;
      if (cursor) {
        try {
          messages = await incrementalSync(access_token, cursor);
        } catch (e) {
          // Gmail expires history older than about a week and answers 404. That
          // is not a failure, it is "you have been away too long" — fall back to
          // a full pass rather than making the account permanently unsyncable.
          if (e.status !== 404) throw e;
          messages = await initialSync(access_token);
        }
      } else {
        messages = await initialSync(access_token);
      }
      return { messages, ...(next ? { cursor: next } : {}) };
    },
  },

  modify_flags: {
    description: "Mirror a local flag change back to Gmail.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        external_id: { type: "string" },
        access_token: { type: "string" },
        flags: { type: "object" },
      },
      required: ["user_id", "external_id", "access_token"],
    },
    run: async ({ external_id, access_token, flags }) => {
      const id = encodeURIComponent(external_id);
      const { add, remove } = labelEdits(flags);
      if (add.length || remove.length) {
        await gmail(access_token, `/messages/${id}/modify`, {
          method: "POST",
          body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
        });
      }
      // Trash and untrash are their own endpoints, not label edits.
      if (flags?.trashed === true) {
        await gmail(access_token, `/messages/${id}/trash`, { method: "POST", body: "{}" });
      } else if (flags?.trashed === false) {
        await gmail(access_token, `/messages/${id}/untrash`, { method: "POST", body: "{}" });
      }
      return {};
    },
  },
};

export function missingRequired(name, args) {
  const required = TOOLS[name]?.inputSchema?.required ?? [];
  return required.filter((k) => {
    const v = args?.[k];
    return v === undefined || v === null || v === "";
  });
}

const server = new Server(
  { name: "leo-gmail", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = TOOLS[name];
  if (!tool) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
  const missing = missingRequired(name, args);
  if (missing.length > 0) {
    return {
      isError: true,
      content: [{ type: "text", text: `${name} requires: ${missing.join(", ")}` }],
    };
  }
  try {
    const answer = await tool.run(args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(answer) }] };
  } catch (error) {
    // `isError` is what the bridge reads to tell "no new mail" from "the sync
    // did not run" — without it an auth failure records as a successful sync of
    // an empty mailbox, and the cursor advances past mail nobody fetched.
    return {
      isError: true,
      content: [{ type: "text", text: String(error?.message ?? error) }],
    };
  }
});

if (process.env.LEO_GMAIL_MCP_NO_SERVE !== "1") {
  await server.connect(new StdioServerTransport());
}
