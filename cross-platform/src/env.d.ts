/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface Window {
  __TAURI_INTERNALS__?: unknown;
  /** Optional runtime proxy origin for a statically hosted index.html. */
  __SIREN_API_BASE__?: string;
}
