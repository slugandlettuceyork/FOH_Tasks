import { getStore } from "@netlify/blobs";

// Simple key/value backend for the FOH Tasks app, backed by Netlify Blobs.
// GET  /api/data?key=<key>          -> { value: <stored json or null> }
// POST /api/data   body: { key, value } -> { ok: true }
//
// This intentionally has no auth of its own (mirrors the Kitchen Tasks app
// pattern) - the app is meant to be shared across kitchen/FOH tablets on
// site. Sensitive actions (editing task lists) are gated client-side by the
// 4-digit admin PIN stored inside the "config" record itself.

const STORE_NAME = "foh-tasks";

export default async (req) => {
  const store = getStore(STORE_NAME);
  const url = new URL(req.url);

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    if (req.method === "GET") {
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
