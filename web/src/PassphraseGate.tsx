import { useState } from "react";

/**
 * Prototype access control.
 *
 * The passphrase lives in sessionStorage only — it is gone when the tab
 * closes, which matters because this gets opened on shared laptops at board
 * meetings. It is never written to localStorage or a cookie.
 *
 * This whole component disappears when Cloudflare Access replaces the shared
 * passphrase with per-person board email access.
 */
export function PassphraseGate({
  onSubmit,
  error,
}: {
  onSubmit: (passphrase: string) => void;
  error?: string;
}) {
  const [value, setValue] = useState("");

  return (
    <main className="gate">
      <h1>HPIC Financial Snapshot</h1>
      <p className="muted">Board use only.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim().length > 0) onSubmit(value.trim());
        }}
      >
        <label htmlFor="passphrase">Passphrase</label>
        <input
          id="passphrase"
          type="password"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit">View dashboard</button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
