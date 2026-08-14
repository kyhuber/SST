import type { AccountSnapshot, FundsSnapshot } from "./types";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * Formats the timestamp QuickBooks reported for the data itself.
 *
 * This is never the current clock. A dashboard that always shows today's date
 * regardless of data freshness is worse than showing no date at all.
 */
function formatRetrievedAt(iso: string | null): string {
  if (!iso) return "No data retrieved";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Retrieval time unavailable";
  // Explicit component options rather than dateStyle/timeStyle: Intl rejects
  // combining those shorthands with timeZoneName, and the zone matters here.
  return date.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function AccountCard({ account }: { account: AccountSnapshot }) {
  return (
    <section className={`card status-${account.status}`}>
      <h2>{account.label}</h2>
      {account.status === "ok" ? (
        <p className="amount">{usd.format(account.balance ?? 0)}</p>
      ) : (
        <p className="amount unavailable">
          {account.status === "not_configured" ? "Not configured" : "Unavailable"}
        </p>
      )}
      {account.note ? <p className="note">{account.note}</p> : null}
    </section>
  );
}

export function FundsSnapshotView({
  snapshot,
  onRetry,
}: {
  snapshot: FundsSnapshot;
  onRetry: () => void;
}) {
  return (
    <main className="dashboard">
      <header>
        <h1>Cash on hand</h1>
        <p className="muted">Highland Park Improvement Club — board financial snapshot</p>
      </header>

      {snapshot.connection === "fixture" ? (
        <p className="banner banner-warn">
          Showing <strong>fixture data</strong>, not real QuickBooks figures. Set{" "}
          <code>QBO_MODE=live</code> on the Worker to connect.
        </p>
      ) : null}

      {snapshot.connection === "not_connected" ? (
        <p className="banner banner-error">
          QuickBooks has never been connected to this dashboard, so there are no figures
          to show. Open <code>/oauth/start</code> on the Worker with the passphrase to
          authorize it.
        </p>
      ) : null}

      {snapshot.connection === "needs_reauth" ? (
        <p className="banner banner-error">
          QuickBooks needs to be reconnected. Open <code>/oauth/start</code> on the Worker
          with the passphrase to re-authorize. No figures below are current until that is
          done.
        </p>
      ) : null}

      <div className="cards">
        {snapshot.accounts.map((account) => (
          <AccountCard key={account.key} account={account} />
        ))}

        <section className="card card-total">
          <h2>Total cash on hand</h2>
          {snapshot.totalCash === null ? (
            <p className="amount unavailable">Not shown</p>
          ) : (
            <p className="amount">{usd.format(snapshot.totalCash)}</p>
          )}
          {snapshot.totalCashNote ? <p className="note">{snapshot.totalCashNote}</p> : null}
        </section>
      </div>

      <footer>
        <p>
          <strong>Source:</strong> {snapshot.source}. This is the QuickBooks book balance —
          it reflects transactions entered in QuickBooks, not the live bank-feed balance,
          which the QuickBooks API does not expose.
        </p>
        <p>
          <strong>Data retrieved from QuickBooks:</strong> {formatRetrievedAt(snapshot.retrievedAt)}
          {snapshot.cached ? " (served from a cached read, refreshed at least every 15 minutes)" : ""}
        </p>
        <p>
          <button type="button" className="link" onClick={onRetry}>
            Reload
          </button>
        </p>
      </footer>
    </main>
  );
}
