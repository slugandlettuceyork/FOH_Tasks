import { getStore } from "@netlify/blobs";

// Simple key/value backend for the FOH Tasks app, backed by Netlify Blobs.
// GET  /api/data?key=<key>          -> { value: <stored json or null> }
// POST /api/data   body: { key, value } -> { ok: true }
//
// This intentionally has no auth of its own (mirrors the Kitchen Tasks app
// pattern) - the app is meant to be shared across kitchen/FOH tablets on
// site. Sensitive actions (editing task lists) are gated client-side by the
// 4-digit admin PIN stored inside the "config" record itself.
//
// consistency: 'strong' below matters - Netlify Blobs defaults to
// "eventual" consistency (fast, edge-cached reads that can lag up to ~60s
// behind the latest write). For a live checklist that's the wrong trade: a
// tick gets saved, then a sync moments later reads a stale cached copy
// without it, and it only reappears once the cache catches up. This bit
// the Kitchen Tasks app the same way; fixed here from the start.

const STORE_NAME = "foh-tasks";

export default async (req) => {
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const url = new URL(req.url);

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    if (req.method === "GET") {
      const list = url.searchParams.get("list");
      if (list !== null) {
        // list=<prefix> -> { keys: [...] }, used by the Admin > Previous
        // weeks viewer to find which dates have stored task data.
        const result = await store.list({ prefix: list });
        const keys = (result.blobs || []).map((b) => b.key);
        return new Response(JSON.stringify({ keys }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }

      const key = url.searchParams.get("key");
      if (!key) {
        return new Response(JSON.stringify({ error: "missing key" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
      const value = await store.get(key, { type: "json" }).catch(() => null);
      return new Response(JSON.stringify({ value: value ?? null }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const { key, value } = body || {};
      if (!key) {
        return new Response(JSON.stringify({ error: "missing key" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
      await store.setJSON(key, value);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    if (req.method === "DELETE") {
      const key = url.searchParams.get("key");
      if (!key) {
        return new Response(JSON.stringify({ error: "missing key" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
      await store.delete(key);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...cors },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
};

export const config = { path: "/api/data" };
