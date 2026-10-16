import { Component, type ReactNode } from "react";

/** Keeps one page's crash from blanking the whole window. */
export class PageBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-10 text-center">
        <p className="text-[17px] font-medium text-foreground">The {this.props.name} page hit a problem.</p>
        <p className="max-w-lg text-[13px] text-muted-foreground">{this.state.error.message}</p>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-2 rounded-full bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.98]"
        >
          Try again
        </button>
      </div>
    );
  }
}
