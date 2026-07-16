export {};

/** Electron `<webview>` guest page (enabled via webPreferences.webviewTag). */
declare global {
  interface HTMLWebViewElement extends HTMLElement {
    src: string;
    partition?: string;
    allowpopups?: boolean;
    loadURL(url: string): void;
    goBack(): void;
    goForward(): void;
    reload(): void;
    canGoBack(): boolean;
    canGoForward(): boolean;
    getURL(): string;
    getTitle(): string;
    stop(): void;
    openDevTools(): void;
    closeDevTools(): void;
    isDevToolsOpened(): boolean;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLWebViewElement> & {
          src?: string;
          partition?: string;
          allowpopups?: string;
          'data-tab-id'?: string;
        },
        HTMLWebViewElement
      >;
    }
  }
}
