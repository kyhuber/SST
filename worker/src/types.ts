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
   * LGL holds every pledge, most of which are individual donor activity
   * rather than grants. Without a scope, a "grant funnel" would
   * quietly be an "everything funnel". Unset is a valid state — the figures
   * still render, but each one carries a visible caveat saying it is not
   * scoped to grants.
   */
  LGL_GRANT_CAMPAIGN_IDS?: string;
  LGL_GRANT_GIFT_CATEGORY_IDS?: string;

  /**
   * Which gift categories hold grant *payments*, as opposed to awards.
   *
   * These are different categories that both display as "Grant" in LGL — 6031
   * holds the type-7 award pledges, 6076 holds the type-1 gifts carrying
   * actual cash. `/gift_categories` returns blank names, so they cannot be
   * told apart by listing them. Unset means Received cannot be computed at
   * all, which renders as unavailable rather than as zero.
   */
  LGL_GRANT_PAYMENT_CATEGORY_IDS?: string;

  /**
   * Base URL of HPIC's Little Green Light tenant, used to deep-link the
   * records named in the data-quality panel. Not a secret and not required:
   * unset simply means the panel lists record IDs without links.
   */
  LGL_UI_BASE_URL?: string;

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

/**
 * Why a funnel figure reads the way it does.
 *
 * "provisional" is not a weaker "ok". It marks a figure computed from Little
 * Green Light that has *not* been reconciled against QuickBooks, which is the
 * system of record for cash. It exists so the dashboard can show a useful
 * number during the prototype without ever implying the books agree with it —
 * the caveat travels with the figure instead of living in a footnote.
 */
export type FunnelStatus = "ok" | "provisional" | "unavailable";

/**
 * The funnel starts at Pledged, not at an application. This tool covers money
 * awarded or promised, not money requested (confirmed with Alex, 2026-08-14).
 */
export interface FunnelStage {
  key: "pledged" | "received" | "outstanding";
  label: string;
  status: FunnelStatus;
  /** Null when status is "unavailable". */
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

/**
 * One record that fails a data-quality rule, named so it can be fixed.
 *
 * The panel exists to be acted on, so a record has to be identifiable by a
 * human: the note usually says what the money was for, and the URL opens the
 * record in Little Green Light.
 */
export interface DataQualityRecord {
  id: number;
  amount: number | null;
  date: string | null;
  /** Funder name. Best-effort — null when it could not be resolved. */
  who: string | null;
  note: string | null;
  /** Null when LGL_UI_BASE_URL is unset. */
  url: string | null;
}

/**
 * A data-quality rule that some records violate.
 *
 * These are first-class output, not error handling. The prototype's whole
 * strategy is that the dashboard makes the cost of a broken record visible in
 * dollars, so that the rules can be introduced with evidence rather than
 * asserted. An exception with no records is omitted entirely.
 */
export interface DataQualityException {
  key: string;
  label: string;
  /** Why it matters, in terms a board member can act on. */
  detail: string;
  /**
   * "blocking" means a figure on this page is wrong or missing because of it.
   * "advisory" means the dashboard copes, but something else — usually LGL's
   * own reporting — does not.
   */
  severity: "blocking" | "advisory";
  recordCount: number;
  /** Total money involved, or null where money is not the unit. */
  amount: number | null;
  /** Capped for display; recordCount is the true total. */
  records: DataQualityRecord[];
}

export interface GrantSnapshot {
  stages: FunnelStage[];
  /**
   * Records failing a data-quality rule. Empty is the goal state, not the
   * normal one.
   */
  exceptions: DataQualityException[];
  /**
   * Awarded amounts split by reimbursable status, never added together. A
   * cost-reimbursement award is not cash available to start work, so a single
   * combined "available" figure would overstate readiness to the board.
   */
  awardsByReimbursable: ReimbursableBucket[];
  /**
   * True when no grant scope is configured, so the figures cover every pledge
   * in LGL rather than grants specifically.
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
