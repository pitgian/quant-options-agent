/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** GitHub user owning the data Gist (optional — falls back to repo `data` branch). */
  readonly VITE_GIST_USER?: string;
  /** GitHub Gist id hosting the generated JSON (optional — falls back to repo `data` branch). */
  readonly VITE_GIST_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
