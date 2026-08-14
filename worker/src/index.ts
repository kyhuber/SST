/**
 * HPIC single source of truth — Cloudflare Worker.
 *
 * The security boundary is this Worker, not the dashboard URL. The frontend is
 * a static shell that holds no credentials, no account identifiers, and no
 * financial data; everything it shows comes from here, and only after the
 * shared passphrase checks out. Someone who finds the Pages URL sees nothing.
 *
 * Phase 1 serves one endpoint of substance: GET /api/funds.
 */

import { AUTH_HEADER, authorize, checkPassphrase } from "./auth";
import { handleCallback, handleStart } from "./oauth";
import { getFunds, listAssetAccounts } from "./qbo";
import { TokenStore } from "./tokens";
import type { Env } from "./types";

export { TokenStore };

/**
 * How long a snapshot is served before we call QuickBooks again. The spec
 * calls for no manual refresh step: the board opens the page and sees current
 * data, with a defined cache interval behind it.
 */
const CACHE_TTL_MS = 15 * 60_000;

/** The single Durable Object instance that owns the QuickBooks tokens. */
function tokenStore(env: Env) {
  return env.TOKEN_STORE.get(env.TOKEN_STORE.idFromName("qbo"));
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": `${AUTH_HEADER}, Content-Type`,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, env: Env, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Financial figures should not sit in browser or intermediary caches.
      "Cache-Control": "no-store",
      ...corsHeaders(env),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method !== "GET") {
      // Nothing in this application writes anywhere. Refuse other verbs
      // outright rather than letting a future edit quietly add one.
      return json({ error: "Method not allowed" }, env, 405);
    }

    switch (url.pathname) {
      // Liveness only. Deliberately reveals nothing about the connection or
      // the data behind it.
      case "/api/health":
        return json({ ok: true }, env);

      case "/api/funds": {
        if (!authorize(request, env)) {
          return json({ error: "Not authorized" }, env, 401);
        }
        return handleFunds(env);
      }

      // Setup tool, not part of the board dashboard: lists chart-of-accounts
      // IDs so operating and rebuild fund can be mapped. Behind the same
      // passphrase, and read-only like everything else.
      case "/admin/accounts": {
        const supplied = url.searchParams.get("k") ?? request.headers.get(AUTH_HEADER);
        if (!checkPassphrase(supplied, env)) {
          return json({ error: "Not authorized" }, env, 401);
        }
        return handleAccountList(env);
      }

      case "/oauth/start":
        return handleStart(request, env, tokenStore(env));

      case "/oauth/callback":
        return handleCallback(request, env, tokenStore(env));

      default:
        return json({ error: "Not found" }, env, 404);
    }
  },
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/** Renders the account list as a table, since a human reads this to configure IDs. */
async function handleAccountList(env: Env): Promise<Response> {
  const result = await listAssetAccounts(env, tokenStore(env));

  const html = (body: string) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>QuickBooks asset accounts</title>` +
        `<style>body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:3rem auto;padding:0 1rem}` +
        `table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #ddd}` +
        `th{font-size:.8rem;text-transform:uppercase;color:#666}code{background:#f1f1f1;padding:.1em .35em;border-radius:3px}` +
        `.num{text-align:right;font-variant-numeric:tabular-nums}.mapped{background:#eef7ee}` +
        `.inactive{color:#999}</style>${body}`,
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
    );

  if (!result.ok) {
    return html(`<h1>QuickBooks asset accounts</h1><p>${escapeHtml(result.detail)}</p>`);
  }

  const mapped = new Set(
    [env.QBO_OPERATING_ACCOUNT_ID, env.QBO_REBUILD_FUND_ACCOUNT_ID].filter(Boolean),
  );

  const rows = result.accounts
    .map((a) => {
      const balance = a.balanceWithSubAccounts ?? a.balance;
      const which =
        a.id === env.QBO_OPERATING_ACCOUNT_ID
          ? " ← operating"
          : a.id === env.QBO_REBUILD_FUND_ACCOUNT_ID
            ? " ← rebuild fund"
            : "";
      const classes = [mapped.has(a.id) ? "mapped" : "", a.active ? "" : "inactive"]
        .filter(Boolean)
        .join(" ");
      return (
        `<tr class="${classes}"><td><code>${escapeHtml(a.id)}</code>${which}</td>` +
        `<td>${escapeHtml(a.name)}${a.active ? "" : " (inactive)"}</td>` +
        `<td>${escapeHtml(a.accountType)}</td><td>${escapeHtml(a.accountSubType)}</td>` +
        `<td class="num">${balance === null ? "—" : balance.toLocaleString("en-US", { style: "currency", currency: "USD" })}</td></tr>`
      );
    })
    .join("");

  return html(
    `<h1>QuickBooks asset accounts</h1>` +
      `<p>Company <code>${escapeHtml(env.QBO_REALM_ID)}</code>. Set <code>QBO_OPERATING_ACCOUNT_ID</code> ` +
      `and <code>QBO_REBUILD_FUND_ACCOUNT_ID</code> in <code>wrangler.toml</code> to the IDs below, then redeploy.</p>` +
      `<table><tr><th>ID</th><th>Name</th><th>Type</th><th>Sub-type</th><th class="num">Balance</th></tr>${rows}</table>`,
  );
}

async function handleFunds(env: Env): Promise<Response> {
  const store = tokenStore(env);

  const cached = await store.getCachedSnapshot(CACHE_TTL_MS);
  if (cached) {
    return json({ ...cached.snapshot, cached: true }, env);
  }

  const snapshot = await getFunds(env, store);

  // Only cache a good read. Caching a failure would keep an outage on screen
  // for fifteen minutes after QuickBooks recovered.
  const worthCaching =
    snapshot.connection === "ok" && snapshot.accounts.some((a) => a.status === "ok");
  if (worthCaching) {
    await store.putCachedSnapshot(snapshot);
  }

  return json(snapshot, env);
}
