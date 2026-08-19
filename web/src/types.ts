/**
 * Mirror of the Worker's response shape (worker/src/types.ts).
 *
 * Kept as a small hand-written copy rather than a shared package: two files to
 * update is a smaller maintenance cost for a volunteer than a build step and a
 * workspace, and this surface changes rarely.
 */

export type AccountStatus = "ok" | "unavailable" | "not_configured";

export interface AccountSnapshot {
  key: "operating" | "rebuild_fund";
  label: string;
  status: AccountStatus;
  balance: number | null;
  hasSubAccounts: boolean;
  note?: string;
}

export interface FundsSnapshot {
  accounts: AccountSnapshot[];
  totalCash: number | null;
  totalCashNote?: string;
  retrievedAt: string | null;
  cached: boolean;
  source: string;
  connection: "ok" | "needs_reauth" | "not_connected" | "fixture";
}

// --- Phase 2: the Little Green Light grant funnel ---

export type FunnelStatus = "ok" | "unavailable";

export interface FunnelStage {
  key: "pledged" | "received" | "outstanding";
  label: string;
  status: FunnelStatus;
  amount: number | null;
  recordCount: number | null;
  note?: string;
}

export type ReimbursableStatus = "reimbursable" | "not_reimbursable" | "unknown";

export interface ReimbursableBucket {
  status: ReimbursableStatus;
  label: string;
  amount: number;
  recordCount: number;
}

export interface GrantSnapshot {
  stages: FunnelStage[];
  awardsByReimbursable: ReimbursableBucket[];
  unscoped: boolean;
  retrievedAt: string | null;
  cached: boolean;
  source: string;
  connection: "ok" | "not_configured" | "unavailable" | "fixture";
  completenessNote: string;
}
