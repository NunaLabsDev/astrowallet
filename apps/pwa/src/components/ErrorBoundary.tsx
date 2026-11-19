import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage?: string | undefined;
}

/**
 * Top-level Liquid Glass error boundary so invalid inputs or transient render faults
 * never crash the wallet shell silently.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || "Unexpected rendering error",
    };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally keep telemetry free of mnemonic or account PII
  }

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <main className="glass-canvas">
        <div className="aw-shell" style={{ paddingTop: 48 }}>
          <section
            className="glass-sheet glass-card--vault"
            role="alert"
            aria-label="Application recovery"
            style={{ display: "grid", gap: 12 }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--aw-stellar-gold)" }}>
              AstroWallet Recovery Mode
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "var(--aw-ink-secondary)" }}>
              A component encountered an unexpected error. Your encrypted SEP-0005 vault in
              IndexedDB remains safe.
            </p>
            {this.state.errorMessage && (
              <div className="aw-banner aw-banner--danger" style={{ fontSize: 12 }}>
                {this.state.errorMessage}
              </div>
            )}
            <button
              type="button"
              className="aw-btn-primary"
              onClick={() => window.location.reload()}
            >
              Recover &amp; Reload AstroWallet
            </button>
          </section>
        </div>
      </main>
    );
  }
}
