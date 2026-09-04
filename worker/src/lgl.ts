/**
 * Little Green Light reads — the Phase 2 grant funnel.
 *
 * Everything in this file is a GET. The dashboard never writes to LGL.
 *
 * ## What the API actually exposes
 *
 * Verified 2026-08-14 against https://api.littlegreenlight.com/api-docs/static.html
 * rather than assumed, and the result differs from the build spec in a way
 * that changes what this dashboard can honestly show:
 *
 * - **There is no `/pledges` endpoint.** The documented resources are appeals,
 *   appeal_requests, gifts, gift_types, gift_categories, campaigns, funds, and
 *   constituents.
 * - The spec's **Pledge** — an award — is a **gift whose gift_type is
 *   "Pledge"**. LGL's stock gift categories include "Grant" under exactly that
 *   type, so this is the intended modelling, not a workaround.
 * - Payments against an award are separate gifts linked by `parent_gift_id`.
 * - There is **no amount-due field**, but amount due is *derivable*: the award
 *   amount minus the payments hanging off it. An earlier note here claimed the
 *   figure was unavailable; that was wrong, and this file now computes it.
 *
 * ## A grant is three records, not one
 *
 * Verified against live LGL on 2026-08-19:
 *
 * | Stage | Type | Category | Carries |
 * | --- | --- | --- | --- |
 * | Application | 14 "Goal" | 6051 "Grant Proposal" | no amount at all |
 * | Award | 7 "Pledge" | 6031 "Grant" | `received_amount` = award face value |
 * | Payment | 1 "Gift" | 6076 "Grant" | `received_amount` = cash received |
 *
 * Each links upward by `parent_gift_id`. Three consequences shape this file:
 *
 * - **`received_amount` on an award is the award, not cash.** So is
 *   `deposited_amount`, stamped at entry and equal on every award including
 *   ones never paid. Reading either as cash overstates by $926,000 live.
 * - **Awards and payments live in different categories that share a display
 *   name.** Hence the separate `LGL_GRANT_PAYMENT_CATEGORY_IDS`.
 * - **Payments frequently do not carry their award's campaign** — three of
 *   eleven have `campaign_id = 0`, including two against the $485,000
 *   Commerce award. So `readPayments` deliberately does **not** filter by
 *   campaign; scoping is applied afterwards by walking `parent_gift_id` up to
 *   an award already known to be in scope. Filtering payments by campaign the
 *   way awards are filtered returns $112,570.29 of that $485,000 and silently
 *   drops $372,429.71.
 *
 * ## Received here is provisional, and says so
 *
 * QuickBooks is the system of record for cash, and `Spent` is not derivable
 * from LGL at all — LGL has no concept of an expense, and invoicing a
 * cost-reimbursement funder requires knowing what HPIC spent. So the figures
 * this file produces for Received and Outstanding are marked `provisional`
 * and labelled as unreconciled, rather than reported as fact.
 *
 * They are still worth rendering. The prototype's strategy is that the
 * dashboard exposes the data gaps and that evidence carries the argument for
 * fixing them, which requires showing something. What makes that honest is
 * that every record breaking a rule is named in the data-quality exceptions
 * below, and no exception is ever absorbed into a total.
 *
 * ## Applications are out of scope
 *
 * This funnel starts at money awarded or promised, not money requested
 * (confirmed with Alex, 2026-08-14). LGL does track applications — they are
 * `appeal_request` records hanging off an appeal — and tracking them is a real
 * need, simply not this tool's. They were read here once; the reads and the
 * `/appeals` enumeration behind them were removed rather than left dormant.
 * Their absence is a decision, not an oversight.
 *
 * ## Scoping
 *
 * LGL holds every pledge, the overwhelming majority of which are individual
 * donor activity rather than grants. `LGL_GRANT_CAMPAIGN_IDS` and
 * `LGL_GRANT_GIFT_CATEGORY_IDS` narrow the reads to grant activity. Both unset
 * is a valid prototype state, but it makes the figures an "everything funnel"
 * rather than a grant funnel, so the snapshot flags itself as unscoped and the
 * UI says so.
 */

import { LGL_FIXTURE_RETRIEVED_AT, lglFixture } from "./lgl-fixtures";
import type {
  DataQualityException,
  DataQualityRecord,
  Env,
  FunnelStage,
  GrantSnapshot,
  ReimbursableBucket,
  ReimbursableStatus,
} from "./types";

const BASE_URL = "https://api.littlegreenlight.com/api/v1";

/** LGL defaults to 25 per page. Larger pages mean fewer round trips. */
const PAGE_SIZE = 100;

/**
 * Refuse to page forever. Hitting this cap makes a figure *incomplete*, which
 * is treated as unavailable rather than reported as a total — a sum missing
 * its last pages understates the funnel exactly the way a dropped account
 * would understate cash.
 */
const MAX_PAGES = 20;

export const SOURCE_LABEL = "Little Green Light";

/**
 * The prototype caveat. LGL is a partial picture: some grants are still
 * tracked manually and have not been entered, and reimbursable status is not
 * populated. Removed at go-live once the development committee confirms
 * reconciliation.
 */
export const COMPLETENESS_NOTE =
  "These figures reflect what is currently recorded in Little Green Light, not HPIC's " +
  "complete grant history. Some grants are still tracked on the manual spreadsheet and " +
  "have not been entered yet. Record counts appear beside every total so a missing grant " +
  "shows up as a count discrepancy rather than a quietly low number.";

/** Custom field name/key that carries cost-reimbursement status. */
const REIMBURSABLE_KEYS = ["reimbursable", "is_reimbursable", "cost_reimbursement"];

// --- LGL response shapes (only the fields this dashboard reads) ---

interface LglCustomFieldValue {
  name?: string | null;
  short_code?: string | null;
}

interface LglCustomField {
  name?: string | null;
  key?: string | null;
  values?: LglCustomFieldValue[] | null;
}

interface LglCustomAttr {
  name?: string | null;
  key?: string | null;
  value?: string | null;
}

export interface LglGift {
  id: number;
  gift_type_id?: number | null;
  gift_type_name?: string | null;
  gift_category_id?: number | null;
  gift_category_name?: string | null;
  campaign_id?: number | null;
  campaign_name?: string | null;
  fund_id?: number | null;
  fund_name?: string | null;
  /**
   * The documented amount field. Some list endpoints echo it as `amount`
   * instead, so both are read and the documented one wins.
   */
  received_amount?: number | null;
  amount?: number | null;
  received_date?: string | null;
  parent_gift_id?: number | null;
  custom_fields?: LglCustomField[] | null;
  /** Needed to name the funder on a data-quality exception. */
  constituent_id?: number | null;
  /** Free text, and in practice the field that says what a payment was for. */
  note?: string | null;
}

/** Only the name fields matter; a constituent is read solely to label a record. */
interface LglConstituent {
  id: number;
  is_org?: boolean | null;
  org_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  sort_name?: string | null;
}

interface LglGiftType {
  id: number;
  name?: string | null;
}

interface LglPage<T> {
  items?: T[] | null;
  items_count?: number;
  total_items?: number;
}

/**
 * A completed read. `complete` is false when paging stopped at MAX_PAGES,
 * which makes any sum over `items` an undercount.
 */
type ReadResult<T> =
  | { ok: true; items: T[]; complete: boolean; date: string | null }
  | { ok: false; detail: string };

// --- HTTP ---

/**
 * The single network call in this file. Fixture mode intercepts here, so every
 * layer above runs identically against recorded data and against LGL.
 */
async function getPage<T>(
  env: Env,
  path: string,
  params: URLSearchParams,
): Promise<{ ok: true; page: LglPage<T>; date: string | null } | { ok: false; detail: string }> {
  if (isFixtureMode(env)) {
    const items = lglFixture(path, params);
    if (!items) {
      return { ok: false, detail: `No fixture recorded for ${path}.` };
    }
    // Fixtures are small enough to return whole; paging is exercised live.
    return {
      ok: true,
      page: { items: items as T[], items_count: items.length, total_items: items.length },
      date: LGL_FIXTURE_RETRIEVED_AT,
    };
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/${path}?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${env.LGL_API_KEY}`,
      },
    });
  } catch (error) {
    return { ok: false, detail: `Could not reach Little Green Light: ${String(error)}` };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      detail:
        "Little Green Light rejected the API key. Check LGL_API_KEY and that the key is " +
        "still active in LGL's integration settings.",
    };
  }
  if (!response.ok) {
    return { ok: false, detail: `Little Green Light returned ${response.status}.` };
  }

  try {
    return {
      ok: true,
      page: (await response.json()) as LglPage<T>,
      // LGL puts no timestamp in the response body, so its `Date` header is
      // the closest thing to the source's own clock. Never our clock.
      date: response.headers.get("date"),
    };
  } catch (error) {
    return { ok: false, detail: `Unreadable response from Little Green Light: ${String(error)}` };
  }
}

/**
 * Fetch one record by path.
 *
 * Separate from `getAll` because `/constituents/{id}` returns a bare object
 * rather than `{ items: [...] }`, so the paging walk would read it as empty.
 * Only used for best-effort labelling, never for a figure.
 */
async function getRecord<T>(env: Env, path: string): Promise<T | null> {
  if (isFixtureMode(env)) {
    const items = lglFixture(path, new URLSearchParams());
    return (items?.[0] as T) ?? null;
  }
  try {
    const response = await fetch(`${BASE_URL}/${path}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${env.LGL_API_KEY}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Page through a list endpoint until it runs out or MAX_PAGES is reached. */
async function getAll<T>(
  env: Env,
  path: string,
  extraParams: Array<[string, string]> = [],
): Promise<ReadResult<T>> {
  const items: T[] = [];
  let date: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    for (const [key, value] of extraParams) params.append(key, value);

    const result = await getPage<T>(env, path, params);
    if (!result.ok) return result;

    date ??= result.date;
    const batch = result.page.items ?? [];
    items.push(...batch);

    const total = result.page.total_items;
    const done =
      batch.length < PAGE_SIZE || (typeof total === "number" && items.length >= total);
    if (done) return { ok: true, items, complete: true, date };
  }

  return { ok: true, items, complete: false, date };
}

function isFixtureMode(env: Env): boolean {
  // Defaults to fixture: an unset mode must never start calling a live API.
  return (env.LGL_MODE ?? "fixture") !== "live";
}

// --- Configuration ---

function parseIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
}

// --- Reading the reimbursable custom field ---

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Map a stored value onto a reimbursable status.
 *
 * Anything unrecognized is "unknown" rather than a guess. Treating an
 * unparseable value as not-reimbursable would quietly move an award into the
 * spendable column, which is the failure this dashboard exists to prevent.
 */
function toReimbursableStatus(raw: string | null | undefined): ReimbursableStatus {
  const value = normalizeKey(raw);
  if (["yes", "y", "true", "1", "reimbursable", "cost_reimbursement"].includes(value)) {
    return "reimbursable";
  }
  if (["no", "n", "false", "0", "not_reimbursable"].includes(value)) {
    return "not_reimbursable";
  }
  return "unknown";
}

/**
 * Read reimbursable status off an LGL record.
 *
 * Returns "unknown" when the field is absent, which is the state every record
 * is in today — HPIC has not defined or populated the custom field yet. The
 * path is built now so that populating the field later lights the feature up
 * with no code change.
 */
export function readReimbursable(record: {
  custom_fields?: LglCustomField[] | null;
  custom_attrs?: LglCustomAttr[] | null;
}): ReimbursableStatus {
  for (const field of record.custom_fields ?? []) {
    const matches =
      REIMBURSABLE_KEYS.includes(normalizeKey(field.key)) ||
      REIMBURSABLE_KEYS.includes(normalizeKey(field.name));
    if (!matches) continue;
    const first = field.values?.[0];
    if (!first) return "unknown";
    return toReimbursableStatus(first.name ?? first.short_code);
  }

  for (const attr of record.custom_attrs ?? []) {
    const matches =
      REIMBURSABLE_KEYS.includes(normalizeKey(attr.key)) ||
      REIMBURSABLE_KEYS.includes(normalizeKey(attr.name));
    if (matches) return toReimbursableStatus(attr.value);
  }

  return "unknown";
}

/** The amount LGL recorded for a gift, preferring the documented field name. */
function giftAmount(gift: LglGift): number {
  const amount = gift.received_amount ?? gift.amount;
  return typeof amount === "number" ? amount : 0;
}

// --- Reads ---

/**
 * Resolve the numeric ID of the "Pledge" gift type.
 *
 * Resolved by name at runtime rather than hardcoded: the IDs look stable
 * across accounts, but a wrong ID here would silently return zero awards,
 * which is indistinguishable from HPIC having no grants.
 */
async function pledgeGiftTypeId(env: Env): Promise<{ ok: true; id: number } | { ok: false; detail: string }> {
  const result = await getAll<LglGiftType>(env, "gift_types");
  if (!result.ok) return result;

  const pledge = result.items.find((type) => normalizeKey(type.name) === "pledge");
  if (!pledge) {
    return {
      ok: false,
      detail:
        "Little Green Light did not report a 'Pledge' gift type, so awards cannot be " +
        "identified. Check the gift types configured in LGL.",
    };
  }
  return { ok: true, id: pledge.id };
}

/** Awards: gifts whose gift type is "Pledge", narrowed to grant activity. */
async function readAwards(env: Env): Promise<ReadResult<LglGift>> {
  const giftType = await pledgeGiftTypeId(env);
  if (!giftType.ok) return giftType;

  const terms = [`gift_types=in|${giftType.id}`];

  const campaignIds = parseIds(env.LGL_GRANT_CAMPAIGN_IDS);
  if (campaignIds.length > 0) terms.push(`campaigns=in|${campaignIds.join(",")}`);

  const categoryIds = parseIds(env.LGL_GRANT_GIFT_CATEGORY_IDS);
  if (categoryIds.length > 0) terms.push(`categories=in|${categoryIds.join(",")}`);

  // LGL combines multiple search terms with a semicolon.
  return getAll<LglGift>(env, "gifts/search", [["q[]", terms.join(";")]]);
}

/**
 * Payments: gifts in the grant *payment* categories.
 *
 * Deliberately NOT filtered by campaign, and that is the single most important
 * line in this file. Payments frequently carry `campaign_id = 0` even when
 * their award is scoped to a campaign — two of the three payments against the
 * $485,000 Commerce award do. Adding `campaigns=in|...` here would return
 * $112,570.29 of that award and silently drop $372,429.71, which is precisely
 * the quiet undercount the completeness rules exist to prevent.
 *
 * Scope is applied afterwards instead, by keeping only payments whose
 * `parent_gift_id` names an award already known to be in scope.
 */
async function readPayments(env: Env): Promise<ReadResult<LglGift> | null> {
  const categoryIds = parseIds(env.LGL_GRANT_PAYMENT_CATEGORY_IDS);
  if (categoryIds.length === 0) return null;
  return getAll<LglGift>(env, "gifts/search", [
    ["q[]", `categories=in|${categoryIds.join(",")}`],
  ]);
}

// --- Funnel assembly ---

function unavailableStage(
  key: FunnelStage["key"],
  label: string,
  note: string,
): FunnelStage {
  return { key, label, status: "unavailable", amount: null, recordCount: null, note };
}

/**
 * A figure computed from LGL that the books have not confirmed.
 *
 * Distinct from "ok" on purpose. QuickBooks is the system of record for cash,
 * so an LGL-derived Received is evidence, not fact, and the status carries
 * that rather than relying on anyone reading a footnote.
 */
function provisionalStage(
  key: FunnelStage["key"],
  label: string,
  amount: number,
  recordCount: number,
  note: string,
): FunnelStage {
  return { key, label, status: "provisional", amount, recordCount, note };
}

/**
 * The note carried by Received and Outstanding.
 *
 * Kept as one string in one place because it is the single most important
 * caveat in Phase 2, and because it is read by the board rather than by a
 * developer. It must state the real reason: these figures are not late, and
 * they are not blocked on Little Green Light.
 */
export const RECONCILIATION_NOTE =
  "Not shown. Cash received is an accounting fact and QuickBooks is the system of record " +
  "for it, but no grant payment category is configured here, so Little Green Light cannot " +
  "supply even a provisional figure. Set LGL_GRANT_PAYMENT_CATEGORY_IDS on the Worker.";

/**
 * The note carried by a provisional Received.
 *
 * The most important sentence on the panel, and written for a board member
 * rather than a developer: it has to say plainly that the books have not
 * confirmed this, without implying the number is worthless.
 */
export const PROVISIONAL_RECEIVED_NOTE =
  "Provisional — from Little Green Light, not reconciled against the books. This sums the " +
  "payment records linked to each award. QuickBooks is the system of record for cash, and " +
  "that reconciliation is not built yet. Payments that were never linked to an award are " +
  "listed under Data quality and are NOT counted here, so the real figure may be higher.";

export const PROVISIONAL_OUTSTANDING_NOTE =
  "Provisional — Pledged minus Received, so it inherits every caveat on Received. If a " +
  "payment is missing its link to an award, this figure overstates what is still owed.";

/** Spent has no LGL answer at all, and never will. Kept separate from the rest. */
export const SPENT_NOTE =
  "Little Green Light has no concept of an expense, so this cannot come from there at any " +
  "level of data quality. It needs QuickBooks to identify each grant on the transactions " +
  "belonging to it.";

const UNSCOPED_NOTE =
  "Not scoped to grants — no grant campaign or gift category is configured, so this counts " +
  "all Little Green Light activity, including individual donor asks and pledges.";

/**
 * Split awards by reimbursable status.
 *
 * Deliberately returns three separate buckets and no combined figure. A
 * cost-reimbursement award requires HPIC to spend first and invoice afterwards,
 * so it does not reduce the working capital needed to begin a construction
 * phase. Summing it with unrestricted awards into one "available" number would
 * materially overstate readiness to the board.
 */
function splitByReimbursable(awards: LglGift[]): ReimbursableBucket[] {
  const labels: Record<ReimbursableStatus, string> = {
    reimbursable: "Reimbursable",
    not_reimbursable: "Not reimbursable",
    unknown: "Reimbursable status unknown",
  };
  const order: ReimbursableStatus[] = ["reimbursable", "not_reimbursable", "unknown"];

  return order.map((status) => {
    const matching = awards.filter((award) => readReimbursable(award) === status);
    return {
      status,
      label: labels[status],
      amount: matching.reduce((sum, award) => sum + giftAmount(award), 0),
      recordCount: matching.length,
    };
  });
}

/**
 * Received and Outstanding, provisionally, from the payment records.
 *
 * Scope is applied here rather than in the query. `readPayments` cannot filter
 * by campaign without dropping payments that carry none, so the narrowing
 * happens against award IDs already known to be in scope: a payment counts if
 * and only if its parent is one of the awards behind Pledged. That also means
 * payments belonging to out-of-scope awards — a Programs grant, say — fall out
 * naturally rather than needing a second rule.
 *
 * Every failure path yields "unavailable" rather than a partial number. An
 * incomplete page walk is the dangerous one: it looks exactly like a smaller
 * account.
 */
function receivedAndOutstanding(
  pledged: FunnelStage,
  awards: ReadResult<LglGift>,
  payments: ReadResult<LglGift> | null,
): FunnelStage[] {
  const unavailable = (note: string) => [
    unavailableStage("received", "Received", note),
    unavailableStage("outstanding", "Outstanding", note),
  ];

  if (payments === null) return unavailable(RECONCILIATION_NOTE);
  if (!payments.ok) return unavailable(payments.detail);
  if (!payments.complete) {
    return unavailable(
      `More Little Green Light payment records than this dashboard reads in one pass ` +
        `(${MAX_PAGES * PAGE_SIZE}). A partial total would understate cash received, so it ` +
        `is not shown.`,
    );
  }
  // Received is defined against the awards behind Pledged, so it cannot be
  // more trustworthy than Pledged is.
  if (!awards.ok || pledged.status !== "ok" || pledged.amount === null) {
    return unavailable(
      "Awards could not be read completely, and cash received is only meaningful against " +
        "the awards it was received for.",
    );
  }

  const awardIds = new Set(awards.items.map((award) => award.id));
  const matched = payments.items.filter(
    (payment) => payment.parent_gift_id != null && awardIds.has(payment.parent_gift_id),
  );
  const received = matched.reduce((sum, payment) => sum + giftAmount(payment), 0);

  return [
    provisionalStage("received", "Received", received, matched.length, PROVISIONAL_RECEIVED_NOTE),
    provisionalStage(
      "outstanding",
      "Outstanding",
      pledged.amount - received,
      pledged.recordCount ?? 0,
      PROVISIONAL_OUTSTANDING_NOTE,
    ),
  ];
}

// --- Data quality ---

/** How many offending records travel with an exception, for display. */
const MAX_EXCEPTION_RECORDS = 12;

/**
 * How many funder names to resolve.
 *
 * Each costs a request, so this is capped rather than unbounded. Labelling is
 * strictly best-effort: a failed lookup leaves `who` null and never affects a
 * figure or suppresses an exception.
 */
const MAX_NAME_LOOKUPS = 12;

function constituentName(record: LglConstituent | null): string | null {
  if (!record) return null;
  if (record.is_org) return record.org_name?.trim() || record.sort_name?.trim() || null;
  const person = [record.first_name, record.last_name].filter(Boolean).join(" ").trim();
  return person || record.sort_name?.trim() || null;
}

function toRecord(env: Env, gift: LglGift, who: string | null): DataQualityRecord {
  const base = env.LGL_UI_BASE_URL?.replace(/\/+$/, "");
  return {
    id: gift.id,
    amount: giftAmount(gift),
    date: gift.received_date ?? null,
    who,
    note: gift.note?.trim() || null,
    url: base ? `${base}/gifts/${gift.id}` : null,
  };
}

/**
 * Resolve funder names for the records about to be displayed.
 *
 * Runs once over the whole exception set so a constituent appearing in two
 * exceptions is fetched once, and so the cap counts distinct people rather
 * than rows.
 */
async function resolveNames(env: Env, gifts: LglGift[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  const ids = [...new Set(gifts.map((g) => g.constituent_id).filter((id): id is number => typeof id === "number"))];
  for (const id of ids.slice(0, MAX_NAME_LOOKUPS)) {
    const name = constituentName(await getRecord<LglConstituent>(env, `constituents/${id}`));
    if (name) names.set(id, name);
  }
  return names;
}

/**
 * Find the records that break a rule.
 *
 * These are the product, not error handling. The prototype ships against
 * imperfect data on purpose, and this is what keeps that honest: every gap is
 * named, counted in dollars, and linked, so the case for changing how records
 * are entered is made from HPIC's own records rather than from an opinion.
 *
 * An exception with no records is dropped, so a clean account shows an empty
 * panel rather than a list of reassurances.
 */
async function findExceptions(
  env: Env,
  awards: LglGift[],
  payments: LglGift[],
): Promise<DataQualityException[]> {
  const unlinkedPayments = payments.filter((p) => !p.parent_gift_id);
  const awardsNoCampaign = awards.filter((a) => !a.campaign_id);
  const awardsNoReimbursable = awards.filter((a) => readReimbursable(a) === "unknown");
  const awardsNoGoal = awards.filter((a) => !a.parent_gift_id);
  const paymentsNoCampaign = payments.filter((p) => p.parent_gift_id && !p.campaign_id);

  const names = await resolveNames(env, [
    ...unlinkedPayments,
    ...awardsNoCampaign,
    ...awardsNoReimbursable,
    ...awardsNoGoal,
    ...paymentsNoCampaign,
  ]);

  const build = (
    key: string,
    label: string,
    detail: string,
    severity: DataQualityException["severity"],
    gifts: LglGift[],
    withAmount: boolean,
  ): DataQualityException | null => {
    if (gifts.length === 0) return null;
    return {
      key,
      label,
      detail,
      severity,
      recordCount: gifts.length,
      amount: withAmount ? gifts.reduce((sum, g) => sum + giftAmount(g), 0) : null,
      records: gifts
        .slice(0, MAX_EXCEPTION_RECORDS)
        .map((g) => toRecord(env, g, names.get(g.constituent_id ?? -1) ?? null)),
    };
  };

  return [
    build(
      "unlinked_payments",
      "Payments not linked to an award",
      "These are in a grant payment category but name no award, so nothing can tell which " +
        "grant they belong to. They are excluded from Received, which means Received is " +
        "understated by up to this amount. Linking each one to its award in Little Green " +
        "Light fixes it. Note that a payment here may not be a grant at all — if it is " +
        "not, the fix is to move it out of the grant category rather than to link it.",
      "blocking",
      unlinkedPayments,
      true,
    ),
    build(
      "awards_missing_reimbursable",
      "Awards with no reimbursable status",
      "Whether an award is cost-reimbursement decides whether it counts as money HPIC can " +
        "spend now. With the custom field unset these are never assumed spendable, so the " +
        "phase-readiness figure cannot be built at all. Defining the field in Little Green " +
        "Light admin and populating it is the single cheapest unblock available.",
      "blocking",
      awardsNoReimbursable,
      true,
    ),
    build(
      "awards_missing_campaign",
      "Awards with no campaign",
      "The funnel is scoped by campaign, so an award without one is invisible here — it " +
        "will not appear in Pledged at all, and no total will look wrong.",
      "blocking",
      awardsNoCampaign,
      true,
    ),
    build(
      "awards_missing_goal",
      "Awards not linked to a proposal",
      "The application record a grant came from. Nothing on this page depends on it, but " +
        "without it the award has no history behind it in Little Green Light.",
      "advisory",
      awardsNoGoal,
      true,
    ),
    build(
      "payments_missing_campaign",
      "Payments with no campaign",
      "This dashboard copes — it reaches the campaign by following the payment up to its " +
        "award — but Little Green Light's own campaign reports do not, and will show less " +
        "money against the campaign than was actually received.",
      "advisory",
      paymentsNoCampaign,
      true,
    ),
  ].filter((e): e is DataQualityException => e !== null);
}

/** Assemble the Phase 2 grant funnel snapshot. */
export async function getGrants(env: Env): Promise<GrantSnapshot> {
  const fixture = isFixtureMode(env);
  const unscoped =
    parseIds(env.LGL_GRANT_CAMPAIGN_IDS).length === 0 &&
    parseIds(env.LGL_GRANT_GIFT_CATEGORY_IDS).length === 0;

  if (!fixture && !env.LGL_API_KEY) {
    return {
      stages: [
        unavailableStage("pledged", "Pledged", "No Little Green Light API key configured."),
        unavailableStage("received", "Received", RECONCILIATION_NOTE),
        unavailableStage("outstanding", "Outstanding", RECONCILIATION_NOTE),
      ],
      exceptions: [],
      awardsByReimbursable: [],
      unscoped,
      retrievedAt: null,
      cached: false,
      source: SOURCE_LABEL,
      connection: "not_configured",
      completenessNote: COMPLETENESS_NOTE,
    };
  }

  const awards = await readAwards(env);
  const payments = await readPayments(env);

  const pledged = toStage("pledged", "Pledged", awards, giftAmount);
  const stages: FunnelStage[] = [pledged, ...receivedAndOutstanding(pledged, awards, payments)];

  // Exceptions need both reads to have succeeded to mean anything: a failed
  // read produces no records, which must not be reported as a clean account.
  const exceptions =
    awards.ok && payments?.ok
      ? await findExceptions(env, awards.items, payments.items)
      : [];

  if (unscoped) {
    for (const stage of stages) {
      if (stage.status !== "ok") continue;
      stage.note = stage.note ? `${stage.note} ${UNSCOPED_NOTE}` : UNSCOPED_NOTE;
    }
  }

  const anyOk = stages.some((stage) => stage.status === "ok");
  const retrievedAt = awards.ok ? awards.date : null;

  return {
    stages,
    exceptions,
    awardsByReimbursable: awards.ok ? splitByReimbursable(awards.items) : [],
    unscoped,
    retrievedAt,
    cached: false,
    source: fixture ? `${SOURCE_LABEL} (fixture data)` : SOURCE_LABEL,
    // Never report "ok" when nothing could be read.
    connection: fixture ? "fixture" : anyOk ? "ok" : "unavailable",
    completenessNote: COMPLETENESS_NOTE,
  };
}

/**
 * Turn one read into a funnel stage.
 *
 * An incomplete read produces "unavailable", not a partial sum. The same rule
 * governs total cash in Phase 1: a total quietly missing records is worse than
 * no total, because nothing on screen says it is wrong.
 */
function toStage<T>(
  key: FunnelStage["key"],
  label: string,
  result: ReadResult<T>,
  amountOf: (item: T) => number,
): FunnelStage {
  if (!result.ok) {
    return unavailableStage(key, label, result.detail);
  }
  if (!result.complete) {
    return unavailableStage(
      key,
      label,
      `More Little Green Light records than this dashboard reads in one pass ` +
        `(${MAX_PAGES * PAGE_SIZE}). A partial total would understate the figure, so it is not shown.`,
    );
  }

  return {
    key,
    label,
    status: "ok",
    amount: result.items.reduce((sum, item) => sum + amountOf(item), 0),
    recordCount: result.items.length,
  };
}
