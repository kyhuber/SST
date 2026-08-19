/**
 * The Phase 2 grant funnel: Pledged → Received → Outstanding.
 *
 * It starts at Pledged deliberately. This tool covers money awarded or
 * promised, not money requested, so grant applications are out of scope
 * (confirmed with Alex, 2026-08-14) — their absence is a decision rather than
 * an unbuilt stage.
 *
 * Two of the three render as "Not shown" against live data, and that is also
 * intended rather than an unfinished panel. Received and Outstanding are cash
 * facts reconciled against QuickBooks, not figures Little Green Light is asked
 * for, and that reconciliation is not built yet. The stage carries the reason
 * with it, so the board reads why a figure is missing instead of wondering
 * whether it is zero.
 */

import { formatRetrievedAt, recordCountLabel, usd } from "./format";
import type { FunnelStage, GrantSnapshot, ReimbursableBucket } from "./types";

function StageCard({ stage }: { stage: FunnelStage }) {
  return (
    <section className={`card status-${stage.status}`}>
      <h2>{stage.label}</h2>
      {stage.status === "ok" ? (
        <p className="amount">{usd.format(stage.amount ?? 0)}</p>
      ) : (
        <p className="amount unavailable">Not shown</p>
      )}
      {/*
        The count appears with every total, never on its own. LGL is a partial
        picture during the prototype: a grant nobody entered shows up here as a
        count that looks wrong long before the total does.
      */}
      {stage.recordCount !== null ? (
        <p className="count">{recordCountLabel(stage.recordCount)}</p>
      ) : null}
      {stage.note ? <p className="note">{stage.note}</p> : null}
    </section>
  );
}

function ReimbursableRow({ bucket }: { bucket: ReimbursableBucket }) {
  return (
    <tr className={bucket.status === "unknown" ? "row-unknown" : undefined}>
      <th scope="row">{bucket.label}</th>
      <td className="num">{usd.format(bucket.amount)}</td>
      <td className="num muted-cell">{recordCountLabel(bucket.recordCount)}</td>
    </tr>
  );
}

export function GrantFunnelView({ snapshot }: { snapshot: GrantSnapshot }) {
  return (
    <section className="panel">
      <h1>Grant funnel</h1>

      {snapshot.connection === "fixture" ? (
        <p className="banner banner-warn">
          Showing <strong>fixture data</strong>, not real Little Green Light figures. Set{" "}
          <code>LGL_MODE=live</code> on the Worker and add <code>LGL_API_KEY</code> to
          connect.
        </p>
      ) : null}

      {snapshot.connection === "not_configured" ? (
        <p className="banner banner-error">
          No Little Green Light API key is configured, so there are no grant figures to
          show. Add <code>LGL_API_KEY</code> as a Worker secret.
        </p>
      ) : null}

      {snapshot.connection === "unavailable" ? (
        <p className="banner banner-error">
          Little Green Light could not be read, so no grant figures are current. The reason
          appears on each figure below.
        </p>
      ) : null}

      {snapshot.unscoped ? (
        <p className="banner banner-warn">
          <strong>Not scoped to grants.</strong> No grant campaign or gift category is
          configured, so these figures count every pledge in Little Green Light —
          individual donor activity included. Set{" "}
          <code>LGL_GRANT_CAMPAIGN_IDS</code> on the Worker to narrow them.
        </p>
      ) : null}

      <div className="cards">
        {snapshot.stages.map((stage) => (
          <StageCard key={stage.key} stage={stage} />
        ))}
      </div>

      {snapshot.awardsByReimbursable.length > 0 ? (
        <div className="subpanel">
          <h2>Awarded, by reimbursable status</h2>
          <p className="note">
            Shown separately and never added together. A cost-reimbursement award requires
            HPIC to spend first and invoice the funder afterwards, so it is not cash
            available to start a construction phase — it changes who ultimately bears the
            cost, not whether work can begin.
          </p>
          <table className="breakdown">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Awarded
                </th>
                <th scope="col" className="num">
                  Records
                </th>
              </tr>
            </thead>
            <tbody>
              {snapshot.awardsByReimbursable.map((bucket) => (
                <ReimbursableRow key={bucket.status} bucket={bucket} />
              ))}
            </tbody>
          </table>
          <p className="note">
            Reimbursable status lives in a Little Green Light custom field that HPIC has
            not defined or populated yet, so awards read as <strong>unknown</strong>. They
            are never assumed to be spendable. Populating the field lights this up with no
            code change.
          </p>
        </div>
      ) : null}

      <div className="panel-footer">
        <p>
          <strong>Source:</strong> {snapshot.source}.
        </p>
        <p className="caveat">{snapshot.completenessNote}</p>
        <p>
          <strong>Data retrieved from Little Green Light:</strong>{" "}
          {formatRetrievedAt(snapshot.retrievedAt)}
        </p>
      </div>
    </section>
  );
}
