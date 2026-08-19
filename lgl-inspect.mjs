/**
 * Read-only Little Green Light inspection, to find the IDs that scope the
 * grant funnel. Every request is a GET; this never writes to LGL.
 *
 * Run from the repository root:
 *   node lgl-inspect.mjs
 *
 * The key comes from worker/.dev.vars, or from LGL_API_KEY in the environment
 * if that is set. It is never printed.
 */

import { readFileSync } from "node:fs";

/** Pull one value out of a .dev.vars / .env style file, if it is there. */
function fromDevVars(name) {
  for (const path of ["worker/.dev.vars", ".dev.vars"]) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1 || trimmed.slice(0, eq).trim() !== name) continue;
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (value) return { value, path };
    }
  }
  return null;
}

const found = process.env.LGL_API_KEY
  ? { value: process.env.LGL_API_KEY, path: "the environment" }
  : fromDevVars("LGL_API_KEY");

if (!found) {
  console.error(
    "No LGL_API_KEY found in worker/.dev.vars or the environment.\n" +
      "Add it to worker/.dev.vars (git-ignored) and re-run. It is never printed.",
  );
  process.exit(1);
}
const KEY = found.value;
console.log("Using the LGL key from " + found.path + ".");

const BASE = "https://api.littlegreenlight.com/api/v1";

async function get(path, params = {}) {
  const qs = new URLSearchParams({ limit: "100", ...params });
  const res = await fetch(BASE + "/" + path + "?" + qs, {
    headers: { Accept: "application/json", Authorization: "Bearer " + KEY },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("LGL rejected the key on /" + path + " (" + res.status + "). Check the key is active.");
  }
  if (!res.ok) throw new Error("/" + path + " returned " + res.status);
  return res.json();
}

function table(rows, cols) {
  if (rows.length === 0) {
    console.log("  (none returned)");
    return;
  }
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(w[i])).join("  ");
  console.log("  " + line(cols));
  console.log("  " + w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log("  " + line(cols.map((c) => r[c])));
}

const money = (n) =>
  typeof n === "number" ? n.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "-";

try {
  console.log("\n=== CAMPAIGNS  ->  LGL_GRANT_CAMPAIGN_IDS ===\n");
  const campaigns = (await get("campaigns")).items ?? [];
  table(campaigns.map((c) => ({ id: c.id, name: c.name, active: c.is_active })), ["id", "name", "active"]);

  console.log("\n=== GIFT CATEGORIES  ->  LGL_GRANT_GIFT_CATEGORY_IDS ===\n");
  const cats = (await get("gift_categories")).items ?? [];
  table(cats.map((c) => ({ id: c.id, name: c.name })), ["id", "name"]);

  console.log("\n=== GIFT TYPES (confirming 'Pledge' resolves by name) ===\n");
  const types = (await get("gift_types")).items ?? [];
  table(types.map((t) => ({ id: t.id, name: t.name })), ["id", "name"]);

  const pledge = types.find((t) => String(t.name ?? "").trim().toLowerCase() === "pledge");
  if (!pledge) {
    console.log("\n  !! No gift type named 'Pledge'. The funnel would read zero awards.");
    process.exit(0);
  }
  console.log("\n  'Pledge' resolves to id " + pledge.id + ".");

  console.log("\n=== PLEDGE GIFTS (what the funnel would actually count) ===\n");
  const gifts = (await get("gifts/search", { "q[]": "gift_types=in|" + pledge.id })).items ?? [];
  console.log("  " + gifts.length + " pledge gift(s) returned (first page, limit 100).\n");

  const by = (key) => {
    const m = new Map();
    for (const g of gifts) {
      const k = g[key] ?? "(none)";
      const e = m.get(k) ?? { n: 0, total: 0 };
      e.n++;
      e.total += g.received_amount ?? g.amount ?? 0;
      m.set(k, e);
    }
    return [...m].map(([name, e]) => ({ name, count: e.n, total: money(e.total) }));
  };

  console.log("  By campaign:");
  table(by("campaign_name"), ["name", "count", "total"]);
  console.log("\n  By gift category:");
  table(by("gift_category_name"), ["name", "count", "total"]);
  console.log("\n  By fund (the restricted / unrestricted dimension):");
  table(by("fund_name"), ["name", "count", "total"]);

  const withCustom = gifts.filter((g) => (g.custom_fields ?? []).length > 0);
  console.log("\n  Pledge gifts carrying any custom field: " + withCustom.length + " of " + gifts.length);
  const names = new Set(withCustom.flatMap((g) => (g.custom_fields ?? []).map((f) => f.name ?? f.key)));
  console.log(
    "  Custom field names seen: " +
      (names.size ? [...names].join(", ") : "(none - reimbursable will read as unknown)"),
  );

  const sample = gifts[0];
  if (sample) {
    console.log("\n  Field names present on a real pledge gift:");
    console.log("    " + Object.keys(sample).sort().join(", "));
  }
} catch (err) {
  console.error("\nFAILED: " + err.message);
  process.exit(1);
}
