import { useCallback, useEffect, useState } from "react";
import { NotAuthorizedError, fetchFunds, fetchGrants } from "./api";
import { FundsSnapshotView } from "./FundsSnapshot";
import { GrantFunnelView } from "./GrantFunnel";
import { PassphraseGate } from "./PassphraseGate";
import type { FundsSnapshot, GrantSnapshot } from "./types";

const STORAGE_KEY = "hpic-sst-passphrase";

/**
 * One panel's data. Kept per-panel rather than as a single page-level state so
 * that a failing source degrades to an inline message on its own panel, and
 * the other panel still renders — QuickBooks being down should not hide the
 * grant funnel.
 */
interface Panel<T> {
  data: T | null;
  error?: string;
}

export function App() {
  const [passphrase, setPassphrase] = useState<string | null>(() =>
    sessionStorage.getItem(STORAGE_KEY),
  );
  const [funds, setFunds] = useState<Panel<FundsSnapshot>>({ data: null });
  const [grants, setGrants] = useState<Panel<GrantSnapshot>>({ data: null });
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [gateError, setGateError] = useState<string | undefined>();

  const load = useCallback(async (secret: string) => {
    setLoading(true);

    // A wrong passphrase is a page-level problem, not a panel-level one: both
    // requests carry the same secret, so both will have failed the same way.
    const forgetPassphrase = (message: string) => {
      sessionStorage.removeItem(STORAGE_KEY);
      setPassphrase(null);
      setGateError(message);
    };

    const [fundsResult, grantsResult] = await Promise.allSettled([
      fetchFunds(secret),
      fetchGrants(secret),
    ]);

    const unauthorized = [fundsResult, grantsResult].find(
      (result) => result.status === "rejected" && result.reason instanceof NotAuthorizedError,
    );
    if (unauthorized && unauthorized.status === "rejected") {
      forgetPassphrase((unauthorized.reason as Error).message);
      setLoading(false);
      return;
    }

    setFunds(toPanel(fundsResult));
    setGrants(toPanel(grantsResult));
    setLoading(false);
    setLoaded(true);
  }, []);

  // Data loads on page load. Nobody runs a script or exports a file.
  useEffect(() => {
    if (passphrase) void load(passphrase);
  }, [passphrase, load]);

  if (!passphrase) {
    return (
      <PassphraseGate
        error={gateError}
        onSubmit={(value) => {
          sessionStorage.setItem(STORAGE_KEY, value);
          setGateError(undefined);
          setPassphrase(value);
        }}
      />
    );
  }

  if (!loaded) {
    return (
      <main className="dashboard">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="dashboard">
      <header>
        <h1 className="page-title">Highland Park Improvement Club</h1>
        <p className="muted">Board financial snapshot</p>
      </header>

      {funds.data ? (
        <FundsSnapshotView snapshot={funds.data} />
      ) : (
        <PanelError title="Cash on hand" detail={funds.error} />
      )}

      {grants.data ? (
        <GrantFunnelView snapshot={grants.data} />
      ) : (
        <PanelError title="Grant funnel" detail={grants.error} />
      )}

      <footer>
        <button type="button" className="link" onClick={() => void load(passphrase)}>
          Reload
        </button>
        {loading ? <span className="muted"> Reloading…</span> : null}
      </footer>
    </main>
  );
}

function toPanel<T>(result: PromiseSettledResult<T>): Panel<T> {
  if (result.status === "fulfilled") return { data: result.value };
  const reason = result.reason;
  return { data: null, error: reason instanceof Error ? reason.message : String(reason) };
}

/** Inline unavailable state for a panel whose request never returned. */
function PanelError({ title, detail }: { title: string; detail?: string }) {
  return (
    <section className="panel">
      <h1>{title}</h1>
      <p className="banner banner-error">
        This panel could not be loaded.{detail ? ` ${detail}` : ""}
      </p>
    </section>
  );
}
