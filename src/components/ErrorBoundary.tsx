import React from 'react';

/**
 * ErrorBoundary — catches unhandled React rendering errors in child components.
 *
 * Without this, any unhandled error in a component's render method causes
 * the entire React tree to unmount, showing a blank white screen.
 * This boundary catches such errors and displays a user-friendly message
 * while logging the error for debugging.
 */

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional name for logging context */
  name?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error(
      `[ErrorBoundary${this.props.name ? `:${this.props.name}` : ''}] Caught error:`,
      error,
      errorInfo.componentStack
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: '2rem',
            maxWidth: '600px',
            margin: '4rem auto',
            textAlign: 'center',
            fontFamily: 'system-ui, sans-serif',
            color: '#333',
          }}
        >
          <h2 style={{ color: '#c01c28', marginBottom: '1rem' }}>
            Something went wrong
          </h2>
          <p style={{ marginBottom: '1rem', lineHeight: 1.5 }}>
            An unexpected error occurred. Your answers have been saved.
          </p>
          <pre
            style={{
              textAlign: 'left',
              background: '#f4f4f4',
              padding: '1rem',
              borderRadius: '8px',
              overflow: 'auto',
              fontSize: '0.85rem',
              maxHeight: '200px',
              marginBottom: '1.5rem',
            }}
          >
            {this.state.error?.message || 'Unknown error'}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '0.75rem 1.5rem',
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '1rem',
            }}
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
