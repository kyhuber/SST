/**
 * Shared types for the HPIC single-source-of-truth Worker.
 *
 * Phase 1 covers QuickBooks Online cash balances. Phase 2 adds the Little
 * Green Light grant funnel. Phase readiness arrives in Phase 3.
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

  // --- Little Green Light (Phase 2) ---

  /**
   * Secret. A freshly issued key scoped to this tool — deliberately not the
   * one the membership lookup tool uses.
   */
  LGL_API_KEY?: string;

  /** "fixture" serves recorded data and never calls LGL. Defaults to fixture. */
  LGL_MODE?: "fixture" | "live";

  /**
   * Which LGL records count as grant activity, as comma-separated IDs.
   *
   * LGL holds every appeal ask and every pledge, most of which are individual
   * donor activity rather than grants. Without a scope, a "grant funnel" would
   * quietly be an "everything funnel". Unset is a valid state — the figures
   * still render, but each one carries a visible caveat saying it is not
   * scoped to grants.
   */
  LGL_GRANT_CAMPAIGN_IDS?: string;
  LGL_GRANT_GIFT_CATEGORY_IDS?: string;

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

// --- Phase 2: the Little Green Light grant funnel ---

/** Why a funnel figure has no number, when it has no number. */
export type FunnelStatus = "ok" | "unavailable";

export interface FunnelStage {
  key: "applied" | "pledged" | "received" | "outstanding";
  label: string;
  status: FunnelStatus;
  /** Null unless status is "ok". */
  amount: number | null;
  /**
   * How many LGL records the figure draws on. Rendered beside every total:
   * LGL is a partial picture during the prototype, so a grant that was never
   * entered shows up as a count discrepancy long before anyone would notice a
   * total being quietly low.
   */
  recordCount: number | null;
  /** Human-readable explanation, shown inline on the panel. */
  note?: string;
}

/**
 * Whether an award is cost-reimbursement.
 *
 * "unknown" is a first-class value, not a placeholder. HPIC has not populated
 * the custom field yet, and a reimbursable award defaulted to spendable is the
 * specific error this dashboard exists to prevent.
 */
export type ReimbursableStatus = "reimbursable" | "not_reimbursable" | "unknown";

export interface ReimbursableBucket {
  status: ReimbursableStatus;
  label: string;
  amount: number;
  recordCount: number;
}

export interface GrantSnapshot {
  stages: FunnelStage[];
  /**
   * Awarded amounts split by reimbursable status, never added together. A
   * cost-reimbursement award is not cash available to start work, so a single
   * combined "available" figure would overstate readiness to the board.
   */
  awardsByReimbursable: ReimbursableBucket[];
  /**
   * True when no grant scope is configured, so the figures cover all LGL
   * appeal asks and pledges rather than grants specifically.
   */
  unscoped: boolean;
  /** LGL's own response clock, never the browser or Worker clock. */
  retrievedAt: string | null;
  cached: boolean;
  source: string;
  connection: "ok" | "not_configured" | "unavailable" | "fixture";
  /** Data-completeness caveat. Removed at go-live, once reconciliation is done. */
  completenessNote: string;
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
