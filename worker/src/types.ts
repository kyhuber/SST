/**
 * Shared types for the HPIC single-source-of-truth Worker.
 *
 * Phase 1 covers QuickBooks Online cash balances only. Little Green Light and
 * phase readiness arrive in Phases 2 and 3.
 */

import type { TokenStore } from "./tokens";

export interface Env {
  // Secrets — set with `wrangler secret put`, never in wrangler.toml.
  QBO_CLIENT_ID: string;
  QBO_CLIENT_SECRET: string;
  ACCESS_PASSPHRASE: string;

  // Plain vars — safe to keep in wrangler.toml.
  QBO_ENV: "sandbox" | "production";
  QBO_MODE: "fixture" | "live";
  QBO_REALM_ID: string;
  QBO_REDIRECT_URI: string;

  // Account mapping. Unset is a valid state during the prototype: the panel
  // renders "not configured" rather than failing.
  QBO_OPERATING_ACCOUNT_ID?: string;
  QBO_REBUILD_FUND_ACCOUNT_ID?: string;

  // Origin of the GitHub Pages frontend, for CORS.
  ALLOWED_ORIGIN?: string;

  TOKEN_STORE: DurableObjectNamespace<TokenStore>;
}

/** Why an account has no number, when it has no number. */
export type AccountStatus = "ok" | "unavailable" | "not_configured";

export interface AccountSnapshot {
  key: "operating" | "rebuild_fund";
  label: string;
  status: AccountStatus;
  /** QuickBooks book balance. Null unless status is "ok". */
  balance: number | null;
  /** True when the account rolls up sub-accounts, so the mapping gets reviewed. */
  hasSubAccounts: boolean;
  /** Human-readable explanation, shown inline on the panel. */
  note?: string;
}

export interface FundsSnapshot {
  accounts: AccountSnapshot[];
  /**
   * Null whenever any account is not "ok". A total that silently omits a
   * failed account overstates cash on hand, which is the exact failure this
   * dashboard exists to prevent.
   */
  totalCash: number | null;
  totalCashNote?: string;
  /** QuickBooks' own response timestamp. Never the browser or Worker clock. */
  retrievedAt: string | null;
  /** Whether this response came from the Worker's cache, and how old it is. */
  cached: boolean;
  source: string;
  connection: "ok" | "needs_reauth" | "not_connected" | "fixture";
}

/** Token payload as returned by Intuit's token endpoint. */
export interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
  token_type: string;
}

/** What the Durable Object hands back to the Worker. */
export type AccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "needs_reauth" | "not_seeded"; detail?: string };
