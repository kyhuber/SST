/**
 * The Phase 2 grant funnel: Pledged → Received → Outstanding.
 *
 * It starts at Pledged deliberately. This tool covers money awarded or
 * promised, not money requested, so grant applications are out of scope
 * (confirmed with Alex, 2026-08-14) — their absence is a decision rather than
 * an unbuilt stage.
 *
 * Received and Outstanding render as **provisional**, which is a deliberate
 * third state rather than a softer "ok". They are computed from Little Green
 * Light's payment records, and QuickBooks — not LGL — is the system of record
 * for cash. Marking them provisional lets the board see a useful figure during
 * the prototype without ever reading it as reconciled.
 *
 * What makes that honest is the data-quality panel below them. Every record
 * breaking a rule is named, counted in dollars, and linked, and no such record
 * is ever absorbed into a total. The panel is the product, not error handling:
 * the prototype ships against imperfect data so that the gaps become visible
 * and arguable from HPIC's own records.
 */

import { formatRetrievedAt, recordCountLabel, usd } from "./format";
import type {
  DataQualityException,
  DataQualityRecord,
  FunnelStage,
  GrantSnapshot,
  ReimbursableBucket,
} from "./types";

function StageCard({ stage }: { stage: FunnelStage }) {
  const hasAmount = stage.status !== "unavailable" && stage.amount !== null;
  return (
    <section className={`card status-${stage.status}`}>
      <h2>{stage.label}</h2>
      {hasAmount ? (
        <p className="amount">{usd.format(stage.amount ?? 0)}</p>
      ) : (
        <p className="amount unavailable">Not shown</p>
      )}
      {/*
        Shown as a badge on the figure itself, not only in the note. A reader
        scanning the numbers has to see that the books have not confirmed this
        one without stopping to read a paragraph.
      */}
      {stage.status === "provisional" ? (
        <p className="provisional-flag">Provisional — not reconciled to the books</p>
      ) : null}
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

function ExceptionRecordRow({ record }: { record: DataQualityRecord }) {
  return (
    <li className="dq-record">
      <span className="dq-record-head">
        <strong>{record.who ?? `Record ${record.id}`}</strong>
        {record.amount !== null ? <span className="dq-amount">{usd.format(record.amount)}</span> : null}
      </span>
      <span className="dq-record-meta">
        {record.date ? <span>{record.date}</span> : null}
        {record.url ? (
          <a href={record.url} target="_blank" rel="noreferrer">
            Open in Little Green Light
          </a>
        ) : (
          <span className="muted-cell">gift {record.id}</span>
        )}
      </span>
      {/* The note is usually what actually identifies the money. */}
      {record.note ? <span className="dq-record-note">“{record.note}”</span> : null}
    </li>
  );
}

function ExceptionCard({ exception }: { exception: DataQualityException }) {
  const hidden = exception.recordCount - exception.records.length;
  return (
    <section className={`dq-card dq-${exception.severity}`}>
      <h3>
        {exception.label}
        <span className="dq-badge">
          {exception.severity === "blocking" ? "Affects a figure above" : "Advisory"}
        </span>
      </h3>
      <p className="dq-summary">
        <strong>{recordCountLabel(exception.recordCount)}</strong>
        {exception.amount !== null ? <> · {usd.format(exception.amount)}</> : null}
      </p>
      <p className="note">{exception.detail}</p>
      <ul className="dq-records">
        {exception.records.map((record) => (
          <ExceptionRecordRow key={record.id} record={record} />
        ))}
      </ul>
      {hidden > 0 ? <p className="note">And {hidden} more not listed here.</p> : null}
    </section>
  );
}

/**
 * The data-quality panel.
 *
 * Rendered only when something is wrong. An empty state congratulating the
 * reader would be noise, and worse, would look identical to a page where
 * nothing was checked.
 */
function DataQualityPanel({ exceptions }: { exceptions: DataQualityException[] }) {
  if (exceptions.length === 0) return null;

  const blocking = exceptions.filter((e) => e.severity === "blocking");
  return (
    <div className="subpanel">
      <h2>Data quality</h2>
      <p className="note">
        Records that break a rule the figures above depend on. Items marked{" "}
        <strong>Affects a figure above</strong> are why a number is missing, provisional, or
        lower than it should be — each one is excluded from the totals rather than guessed
        at. Fixing a record in Little Green Light changes this page on the next read.
      </p>
      {blocking.length > 0 ? (
        <p className="banner banner-warn">
          <strong>
            {blocking.reduce((sum, e) => sum + e.recordCount, 0)} record(s) are affecting the
            figures above.
          </strong>{" "}
          The grant totals on this page cannot be treated as complete until these are
          resolved.
        </p>
      ) : null}
      <div className="dq-list">
        {exceptions.map((exception) => (
          <ExceptionCard key={exception.key} exception={exception} />
        ))}
      </div>
      <p className="note">
        This checks what can be checked automatically. It cannot tell whether money in a
        grant category is really a grant — a fee-for-service payment filed as one looks
        identical here — so the category itself still needs a human eye.
      </p>
    </div>
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

      <DataQualityPanel exceptions={snapshot.exceptions} />

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
