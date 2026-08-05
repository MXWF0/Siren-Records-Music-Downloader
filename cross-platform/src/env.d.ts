/// <reference types="vite/client" />

interface Window {
  __TAURI_INTERNALS__?: unknown;
  /** Optional runtime proxy origin for a statically hosted index.html. */
  __SIREN_API_BASE__?: string;
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
}
