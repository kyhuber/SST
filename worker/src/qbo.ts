/**
 * QuickBooks Online reads. Everything in this file is a GET against the
 * Accounting API — the dashboard is read-only by design and must never write
 * to QuickBooks.
 *
 * Balances come from the Account entity. There is no dedicated balance
 * endpoint, and the bank-feed "Bank balance" shown in the QuickBooks UI is not
 * exposed by the API at all; what we get is the QuickBooks book balance (the
 * "In QuickBooks" figure). That is the right number for this dashboard — QBO is
 * the system of record — but the UI labels it honestly rather than calling it
 * a bank balance.
 *
 * https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/account
 */

import type { AccountSnapshot, Env, FundsSnapshot } from "./types";
import { FIXTURE_RETRIEVED_AT, fixtureAccount } from "./fixtures";
import type { TokenStore } from "./tokens";

const BASE_URLS = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
} as const;

/**
 * Minor versions 1-74 were discontinued on August 1, 2025; anything below 75
 * is ignored and answered as 75, and an unspecified version also defaults to
 * 75 today. Pin it explicitly so a future change to that default cannot move
 * the data under us without a code change.
 */
const MINOR_VERSION = "75";

export interface QboAccount {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  AccountType?: string;
  AccountSubType?: string;
  Classification?: string;
  CurrentBalance?: number;
  CurrentBalanceWithSubAccounts?: number;
  Active?: boolean;
  SubAccount?: boolean;
  MetaData?: { LastUpdatedTime?: string };
}

interface QboAccountResponse {
  Account: QboAccount;
  /** QuickBooks' own response timestamp — the honest retrieval time. */
  time: string;
}

export type AccountReadResult =
  | { ok: true; account: QboAccount; time: string }
  | { ok: false; kind: "unauthorized" | "not_found" | "error"; detail: string };

interface AccountConfig {
  key: AccountSnapshot["key"];
  label: string;
  id?: string;
}

export const SOURCE_LABEL = "QuickBooks Online — book balance";

function baseUrl(env: Env): string {
  return BASE_URLS[env.QBO_ENV === "production" ? "production" : "sandbox"];
}

/** Read a single account by ID. */
async function readAccount(
  env: Env,
  accessToken: string,
  accountId: string,
): Promise<AccountReadResult> {
  const url =
    `${baseUrl(env)}/v3/company/${env.QBO_REALM_ID}` +
    `/account/${encodeURIComponent(accountId)}?minorversion=${MINOR_VERSION}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error) {
    return { ok: false, kind: "error", detail: `Could not reach QuickBooks: ${String(error)}` };
  }

  if (response.status === 401) {
    return { ok: false, kind: "unauthorized", detail: "Access token rejected" };
  }
  if (!response.ok) {
    // intuit_tid identifies the request in Intuit's logs; worth surfacing when
    // someone has to open a support case.
    const tid = response.headers.get("intuit_tid") ?? "none";
    const kind = response.status === 404 || response.status === 400 ? "not_found" : "error";
    return {
      ok: false,
      kind,
      detail: `QuickBooks returned ${response.status} (intuit_tid: ${tid})`,
    };
  }

  const body = (await response.json()) as QboAccountResponse;
  if (!body.Account) {
    return { ok: false, kind: "error", detail: "QuickBooks response had no Account" };
  }
  return { ok: true, account: body.Account, time: body.time };
}

/**
 * Turn one account read into a display row.
 *
 * We show CurrentBalanceWithSubAccounts as the headline: it equals
 * CurrentBalance when an account has no sub-accounts, and when it does have
 * them it is the number a treasurer means by "the rebuild fund". Where the two
 * differ we say so, so that the account mapping gets reviewed rather than
 * silently misread.
 */
function toSnapshot(config: AccountConfig, result: AccountReadResult): AccountSnapshot {
  if (!result.ok) {
    return {
      key: config.key,
      label: config.label,
      status: "unavailable",
      balance: null,
      hasSubAccounts: false,
      note:
        result.kind === "not_found"
          ? "Account not found in QuickBooks — check the configured account ID."
          : result.detail,
    };
  }

  const { account } = result;
  const rollup = account.CurrentBalanceWithSubAccounts;
  const own = account.CurrentBalance;
  const balance = rollup ?? own;

  if (typeof balance !== "number") {
    return {
      key: config.key,
      label: config.label,
      status: "unavailable",
      balance: null,
      hasSubAccounts: false,
      note: "QuickBooks returned no balance for this account. Balances are only valid for balance-sheet accounts.",
    };
  }

  const hasSubAccounts =
    typeof rollup === "number" && typeof own === "number" && rollup !== own;

  return {
    key: config.key,
    label: config.label,
    status: "ok",
    balance,
    hasSubAccounts,
    note: hasSubAccounts
      ? `Includes sub-accounts. This account alone is ${own!.toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
        })}.`
      : undefined,
  };
}

/** An account row for an ID that was never configured. */
function notConfigured(config: AccountConfig): AccountSnapshot {
  return {
    key: config.key,
    label: config.label,
    status: "not_configured",
    balance: null,
    hasSubAccounts: false,
    note: "No QuickBooks account ID configured yet.",
  };
}

/** An account row for when we could not authenticate at all. */
function connectionUnavailable(config: AccountConfig, detail: string): AccountSnapshot {
  return {
    key: config.key,
    label: config.label,
    status: "unavailable",
    balance: null,
    hasSubAccounts: false,
    note: detail,
  };
}

/**
 * Total cash on hand.
 *
 * Returns null unless every configured account reported successfully. A total
 * that silently drops a failed account overstates available cash, which is the
 * specific kind of error this dashboard exists to prevent. Better to show
 * nothing and say why.
 */
function totalOf(accounts: AccountSnapshot[]): { total: number | null; note?: string } {
  const usable = accounts.filter((a) => a.status === "ok");
  if (usable.length === 0) {
    // "Could not be read" and "was never mapped" are different problems and
    // send someone looking in different places.
    const noneMapped = accounts.every((a) => a.status === "not_configured");
    return {
      total: null,
      note: noneMapped
        ? "No QuickBooks accounts have been mapped yet."
        : "No account balances could be read.",
    };
  }
  if (usable.length !== accounts.length) {
    const missing = accounts
      .filter((a) => a.status !== "ok")
      .map((a) => a.label)
      .join(", ");
    return {
      total: null,
      note: `Not shown — ${missing} could not be read, so any total would understate cash on hand.`,
    };
  }
  return { total: usable.reduce((sum, a) => sum + (a.balance ?? 0), 0) };
}

function accountConfigs(env: Env): AccountConfig[] {
  return [
    { key: "operating", label: "Operating account", id: env.QBO_OPERATING_ACCOUNT_ID },
    { key: "rebuild_fund", label: "Rebuild fund", id: env.QBO_REBUILD_FUND_ACCOUNT_ID },
  ];
}

export interface AccountListEntry {
  id: string;
  name: string;
  accountType: string;
  accountSubType: string;
  balance: number | null;
  balanceWithSubAccounts: number | null;
  active: boolean;
  isSubAccount: boolean;
}

/**
 * List the company's asset accounts, for mapping operating and rebuild fund to
 * their QuickBooks IDs.
 *
 * This exists because chart-of-accounts IDs are not visible anywhere in the
 * QuickBooks UI, and they have to be configured before the dashboard shows a
 * single number. It is a setup tool, not part of the board-facing dashboard.
 */
export async function listAssetAccounts(
  env: Env,
  store: DurableObjectStub<TokenStore>,
): Promise<{ ok: true; accounts: AccountListEntry[] } | { ok: false; detail: string }> {
  const token = await store.getAccessToken();
  if (!token.ok) {
    return {
      ok: false,
      detail:
        token.reason === "needs_reauth"
          ? "QuickBooks needs to be reconnected. Visit /oauth/start."
          : "QuickBooks is not connected. Visit /oauth/start.",
    };
  }

  // Classification is a filterable field. Active is filtered below rather than
  // in the query, to keep the query string simple and hard to get wrong.
  const statement = "select * from Account where Classification = 'Asset'";
  const url =
    `${baseUrl(env)}/v3/company/${env.QBO_REALM_ID}/query` +
    `?query=${encodeURIComponent(statement)}&minorversion=${MINOR_VERSION}`;

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token.accessToken}` },
  });

  if (!response.ok) {
    const tid = response.headers.get("intuit_tid") ?? "none";
    return { ok: false, detail: `QuickBooks returned ${response.status} (intuit_tid: ${tid})` };
  }

  const body = (await response.json()) as { QueryResponse?: { Account?: QboAccount[] } };
  const accounts = (body.QueryResponse?.Account ?? []).map((a) => ({
    id: a.Id,
    name: a.FullyQualifiedName ?? a.Name,
    accountType: a.AccountType ?? "",
    accountSubType: a.AccountSubType ?? "",
    balance: typeof a.CurrentBalance === "number" ? a.CurrentBalance : null,
    balanceWithSubAccounts:
      typeof a.CurrentBalanceWithSubAccounts === "number"
        ? a.CurrentBalanceWithSubAccounts
        : null,
    active: a.Active !== false,
    isSubAccount: a.SubAccount === true,
  }));

  return { ok: true, accounts };
}

/** Assemble the Phase 1 funds snapshot. */
export async function getFunds(env: Env, store: DurableObjectStub<TokenStore>): Promise<FundsSnapshot> {
  const configs = accountConfigs(env);

  if (env.QBO_MODE === "fixture") {
    return fixtureSnapshot(configs);
  }

  const token = await store.getAccessToken();
  if (!token.ok) {
    const detail =
      token.reason === "needs_reauth"
        ? "QuickBooks needs to be reconnected. Visit /oauth/start to re-authorize."
        : token.detail ?? "QuickBooks has never been connected. Visit /oauth/start to authorize.";
    // Every account is unavailable when we cannot authenticate, including ones
    // with no ID configured — reporting "not configured" here would blame the
    // wrong thing.
    const accounts = configs.map((c) => connectionUnavailable(c, detail));
    const { total, note } = totalOf(accounts);
    return {
      accounts,
      totalCash: total,
      totalCashNote: note,
      retrievedAt: null,
      cached: false,
      source: SOURCE_LABEL,
      // Never report "ok" when we could not reach QuickBooks at all. A panel
      // full of blanks under a healthy-looking status is the kind of quiet
      // dishonesty this dashboard exists to avoid.
      connection: token.reason === "needs_reauth" ? "needs_reauth" : "not_connected",
    };
  }

  const configured = configs.filter((c) => c.id);
  let results = await Promise.all(
    configured.map(async (c) => ({
      config: c,
      result: await readAccount(env, token.accessToken, c.id!),
    })),
  );

  // A token we believed was valid can still be rejected — for instance if it
  // expired between our expiry check and the call. Force one refresh and retry
  // only the calls that failed that way.
  if (results.some((r) => !r.result.ok && r.result.kind === "unauthorized")) {
    const retryToken = await store.getAccessToken(true);
    if (retryToken.ok) {
      results = await Promise.all(
        results.map(async (r) => {
          if (r.result.ok || r.result.kind !== "unauthorized") return r;
          return {
            config: r.config,
            result: await readAccount(env, retryToken.accessToken, r.config.id!),
          };
        }),
      );
    }
  }

  const byKey = new Map(results.map((r) => [r.config.key, toSnapshot(r.config, r.result)]));
  const accounts = configs.map((c) => byKey.get(c.key) ?? notConfigured(c));

  const firstSuccess = results.find((r) => r.result.ok);
  const retrievedAt = firstSuccess?.result.ok ? firstSuccess.result.time : null;

  const { total, note } = totalOf(accounts);

  return {
    accounts,
    totalCash: total,
    totalCashNote: note,
    retrievedAt,
    cached: false,
    source: SOURCE_LABEL,
    connection: "ok",
  };
}

/** Fixture mode: exercises the whole UI before any credentials exist. */
function fixtureSnapshot(configs: AccountConfig[]): FundsSnapshot {
  const accounts = configs.map((c) => toSnapshot(c, fixtureAccount(c.key)));
  const { total, note } = totalOf(accounts);
  return {
    accounts,
    totalCash: total,
    totalCashNote: note,
    retrievedAt: FIXTURE_RETRIEVED_AT,
    cached: false,
    source: `${SOURCE_LABEL} (fixture data)`,
    connection: "fixture",
  };
}
