import { Component, type ReactNode } from "react";

/**
 * A rendering bug should not leave a blank screen in front of the board.
 *
 * The spec's standard throughout is that an honest "unavailable" beats a clean
 * surface hiding a problem; a white page is the worst version of that, because
 * it looks like the dashboard simply has nothing to say.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <main className="dashboard">
        <h1>Cash on hand</h1>
        <p className="banner banner-error">
          The dashboard failed to render, so no figures below can be trusted. Reload the
          page; if it keeps happening, report this message: {this.state.message}
        </p>
      </main>
    );
  }
}
