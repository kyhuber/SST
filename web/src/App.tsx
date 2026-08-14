import { useCallback, useEffect, useState } from "react";
import { NotAuthorizedError, fetchFunds } from "./api";
import { FundsSnapshotView } from "./FundsSnapshot";
import { PassphraseGate } from "./PassphraseGate";
import type { FundsSnapshot } from "./types";

const STORAGE_KEY = "hpic-sst-passphrase";

export function App() {
  const [passphrase, setPassphrase] = useState<string | null>(() =>
    sessionStorage.getItem(STORAGE_KEY),
  );
  const [snapshot, setSnapshot] = useState<FundsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [gateError, setGateError] = useState<string | undefined>();

  const load = useCallback(async (secret: string) => {
    setLoading(true);
    setError(undefined);
    try {
      setSnapshot(await fetchFunds(secret));
    } catch (caught) {
      if (caught instanceof NotAuthorizedError) {
        // Wrong passphrase: drop it and show the gate again rather than
        // leaving a stale secret in the tab.
        sessionStorage.removeItem(STORAGE_KEY);
        setPassphrase(null);
        setGateError(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setLoading(false);
    }
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

  if (loading && !snapshot) {
    return (
      <main className="dashboard">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (error && !snapshot) {
    return (
      <main className="dashboard">
        <h1>Cash on hand</h1>
        <p className="banner banner-error">Could not load the dashboard. {error}</p>
        <button type="button" onClick={() => void load(passphrase)}>
          Try again
        </button>
      </main>
    );
  }

  if (!snapshot) return null;

  return <FundsSnapshotView snapshot={snapshot} onRetry={() => void load(passphrase)} />;
}
