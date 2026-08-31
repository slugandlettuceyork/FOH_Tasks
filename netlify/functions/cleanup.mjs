import { getStore } from "@netlify/blobs";

// Runs daily. Task sign-off data (taskstate:<date>) only needs to be kept
// for 2 weeks - the Admin > Previous weeks viewer reads from this same
// store, so anything older than the retention window is deleted here
// rather than left to grow forever. Config, the order sheet, and admin
// settings are untouched - only date-keyed taskstate:* records expire.

const STORE_NAME = "foh-tasks";
const RETENTION_DAYS = 14;

export default async () => {
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const result = await store.list({ prefix: "taskstate:" });
  const keys = (result.blobs || []).map((b) => b.key);

  let deleted = 0;
  for (const key of keys) {
    const dateStr = key.slice("taskstate:".length);
    const d = new Date(dateStr + "T00:00:00");
    if (!isNaN(d) && d < cutoff) {
      await store.delete(key);
      deleted++;
    }
  }

  return new Response(JSON.stringify({ ok: true, checked: keys.length, deleted }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = { schedule: "@daily" };
