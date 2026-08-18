# HPIC single source of truth — build spec

## What this is

Highland Park Improvement Club is a volunteer-run neighborhood nonprofit in
Seattle, rebuilding its clubhouse after a 2021 fire. The board has no single
place to see the organization's financial position. Answering "can we afford to
start the next construction phase" today means manually cross-referencing
QuickBooks, a hand-maintained grant spreadsheet, and a contractor estimate.

This tool is a read-only, internal, board-facing dashboard answering three
questions:

1. How much cash do we actually have right now?
2. How much grant money has been awarded to us, and how much is still owed?
3. Can we afford to start the next construction phase?

It does not move money, does not write to any system, and is not public.

**Design principle: every number traces to a system of record.** Replacing the
manual spreadsheet process is the point of this tool, not a side effect. Do not
introduce a spreadsheet as a data source. If a number cannot be sourced from an
API, it is either configuration or it does not appear.

## Data sources

Two APIs. No Google Sheets, no CSV imports, no manual data entry layer.

### QuickBooks Online — authoritative for cash

QBO's bank feed already imports real bank transactions, so **do not integrate
with a bank directly**. No Plaid, no aggregator. QBO is the aggregation layer.

Needed: current balance of the operating account and the rebuild fund.

Check current Intuit developer documentation for how to pull account balances
rather than assuming an endpoint shape. Handle OAuth2 token refresh so this runs
unattended.

### Little Green Light — authoritative for grants

HPIC's grant process maps directly onto LGL's native objects. This is the core
domain model and the most important thing to get right:

- **Pledge** — created when the grant is awarded. Carries an amount and,
  importantly, an **amount due** field.
- **Gift** — recorded when payment arrives, applied against the pledge.

This produces the funnel with no derivation required:

    Pledged (pledge amounts)
      → Received (pledge amount minus amount due)
        → Outstanding (pledge amount due)

Use LGL's `amount due` directly rather than summing gifts against pledges
yourself. LGL already maintains it, and recomputing invites drift.

**Applications are deliberately out of scope** (confirmed with Alex,
2026-08-14). This tool starts at money awarded or promised, not money requested.
LGL's Goal object does track grant applications, and tracking them is a real
need — it is simply not this tool's need. Do not add goals back without
revisiting that decision, and do not treat their absence as an oversight.

Reuse the existing LGL integration pattern and API key handling from the
membership lookup tool. Verify current endpoint shapes against LGL's API
documentation at `api.littlegreenlight.com/api-docs/` rather than assuming.

**Restriction comes from campaigns and funds**, not from a separate attribute.
LGL treats restricted vs. unrestricted as a canonical use of campaigns, and
campaigns and funds are both exposed via the API. Read the campaign or fund a
pledge is coded to and use that as the restriction dimension. Do not build a
parallel restriction taxonomy.

## Reimbursement — the correctness requirement

A cost-reimbursement grant does not function as cash available to start work.
HPIC must spend first and invoice the funder afterward. A reimbursable award
does not reduce the working capital needed to begin a construction phase; it
changes who ultimately bears the cost, not whether work can start.

Two of HPIC's largest awards, roughly $900,000 combined, are cost-reimbursement
and have no signed contract. If the dashboard presents these as funding
available toward construction, it will materially overstate readiness to the
board. **This is the specific failure mode the tool exists to prevent.**

Rules that follow:

- Never sum reimbursable and non-reimbursable awards into a single "available"
  figure.
- Wherever an award total appears, its reimbursable status appears with it.
- Phase readiness is calculated from spendable cash, never from total awards.
- Where reimbursable status is unknown, display it as unknown. Do not default
  to treating an award as cash.

### Where this data lives

Reimbursable status and contract-signed status are not native LGL fields. LGL
supports custom fields and custom attributes on its API objects, so these should
become custom fields on the pledge.

**Verification step before building this part**: confirm in LGL admin settings
whether Pledge appears as an available item type for custom fields. If it does,
define `reimbursable` and `contract_signed` as custom fields and read them
through the API alongside the rest of the record.

If they are not yet defined or populated, build the display path anyway and
have it render "unknown" when the field is absent. The prototype should be
correct-by-construction here, so that populating the field later lights up the
feature with no code change.

## Hosting and security

- **Frontend**: React, static build, GitHub Pages, served from
  `sst.hpic1919.org`. The repository lives under the HPIC GitHub organization,
  not a personal account — the org hosts several tools other members need to
  reach, and a volunteer-run nonprofit should not depend on one person's login.
- **Middleware**: Cloudflare Worker. Reuse the existing Worker and Pages setup
  from the membership lookup tool. The Cloudflare account remains personal for
  now and transfers to the organization later; the Worker URL is the Intuit
  OAuth redirect URI, so moving it is the step with real switching cost and is
  deliberately deferred rather than bundled with the GitHub move.
- **No separate database.** Freshness comes from an hourly cron and a snapshot
  cached in Durable Object storage, so a page load does not hit QuickBooks or
  LGL. D1 was considered and declined: this is a point-in-time snapshot, trends
  are out of scope, and each extra storage layer is another place a figure can
  be separated from the retrieval timestamp that makes it trustworthy.
- **The security boundary is the Worker, not the URL.** The frontend holds no
  financial data, no credentials, no account identifiers. It is a shell that
  requests data from the Worker. Someone who finds the URL should see nothing.
- **Prototype access control**: the Worker requires a shared passphrase before
  returning data. The frontend prompts and passes it per request. Not in the
  repo. `sessionStorage` is acceptable; avoid persisting across sessions on
  shared machines.
- **Later, not now**: Cloudflare Access with a board email allowlist, giving
  per-person access instead of a shared secret. Structure the Worker so this
  can sit in front without rework.
- All credentials — QBO OAuth tokens, LGL API key, shared passphrase — live
  only in Worker environment variables.

## Configuration

Values with no system of record. Worker environment variables, not a spreadsheet
and not hardcoded in the frontend:

- `QBO_OPERATING_ACCOUNT_ID` — not yet confirmed
- `QBO_REBUILD_FUND_ACCOUNT_ID` — not yet confirmed
- `CURRENT_PHASE_NAME` — "Dry-in"
- `CURRENT_PHASE_TARGET_COST` — not yet confirmed with the general contractor
- `ACCESS_PASSPHRASE`

## Build order

Build each phase end to end, including UI, before moving on.

### Phase 1 — Funds snapshot

Operating balance, rebuild fund balance, total cash on hand. QBO only.

No dependency on anyone else. Build against QBO sandbox data with account IDs
as config so real IDs drop in later.

### Phase 2 — Grant funnel

Three figures from LGL: pledged, received, outstanding.

Then:

- Break out by campaign or fund so restricted and unrestricted are visible
  separately.
- Provide a detail view listing individual pledges with their status, campaign,
  amounts, and reimbursable status where known.
- Split the outstanding figure by reimbursable vs. not. That split is the single
  most decision-relevant number on the dashboard.

### Phase 3 — Phase readiness

Spendable cash against the current phase target cost, as a progress bar and
percent-funded figure.

Spendable excludes reimbursable awards not yet received. Make the exclusion
visible rather than silently applied — a line reading "excludes $900,000 in
unreceived reimbursable awards" is more useful than a clean number hiding the
caveat.

Percent-funded is independently useful to the development team: several major
foundation prospects will not consider a capital request until HPIC has secured
a threshold share of the total, one at 40% and another at 70%. Surfacing
percent-funded shows when those unlock.

## Data completeness during the prototype

LGL is currently a partial picture. Some grants tracked manually have not been
entered, and reimbursable and contract status are not yet populated as custom
fields. Reconciling this is a planned go-live task owned by the development
committee, not a prototype blocker.

The prototype reads LGL as it stands. The obligation on the build is honesty
about what that means:

- Label grant figures as reflecting what is in LGL, not as a complete grant
  history.
- Show record counts alongside totals so a missing grant is visible as a count
  discrepancy rather than a silently low number.
- Render unknown reimbursable status as unknown, never as a default.

Remove these caveats at go-live, once reconciliation is confirmed complete.

## Non-functional requirements

- **Read-only.** Never write or post to QBO, LGL, or any bank.
- **No manual refresh step.** Data loads on page load or a defined cache
  interval. Nobody runs a script or exports a file to update this.
- **Graceful degradation.** If one source fails, other panels still render.
  Inline unavailable state on the affected panel.
- **Honest staleness.** Display the actual retrieval timestamp of the underlying
  data, not the current clock time. A dashboard that always shows today's date
  regardless of data freshness is worse than showing no date at all.
- **Desktop layout.** Shown on a laptop at board meetings. Mobile is not a
  priority.
- **Maintainable by someone else.** Volunteer organization, no paid staff.
  Favor clarity over cleverness, minimal dependencies, and include a README
  covering credential rotation, account mapping, config changes, and redeploy.

## Go-live checklist

Not prototype work. Recorded here so it isn't lost. `KYLE-TODO.md` tracks which
of these are in flight; this is the canonical list.

- Development committee reconciles manual grant tracking into LGL
- `reimbursable` and `contract_signed` custom fields defined and populated
- Campaign and fund coding reviewed so restriction breakdown is accurate
- Real QBO account IDs confirmed with the treasurer
- Dry-in target cost confirmed with the general contractor
- Data-completeness caveats removed from the UI
- Cloudflare Access replaces the shared passphrase
- Repository transferred to the HPIC GitHub organization
- Dashboard served from `sst.hpic1919.org`
- QuickBooks production keys approved, and the Intuit developer account held on
  an organization address that survives any one person leaving
- Cloudflare account transferred to the organization (deferred; the Worker URL
  is the Intuit redirect URI, so this one is not free)

## Out of scope

- Any write-back to QBO or LGL
- Per-person authentication for the prototype
- Historical trend charts — point-in-time snapshot only
- Prospect and pipeline tracking for grants not yet applied for. These have no
  LGL representation until application, and the research notes behind them are
  qualitative. Out of scope here.
- Determining whether a given expenditure qualifies against a specific
  restricted grant. This is a real and painful problem for the development
  committee, but it depends on QBO class or fund tracking being configured
  correctly first. Likely future direction; do not build now.
- Mobile-responsive layout
