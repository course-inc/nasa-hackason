import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// __DUCKDB_LOCAL__: bundle the DuckDB wasm (Tauri sets TAURI_ENV_PLATFORM in beforeBuildCommand;
// e2e sets DUCKDB_LOCAL=1 to run offline). The web build loads it from jsDelivr instead (db.ts).
const duckdbLocal = !!process.env.TAURI_ENV_PLATFORM || process.env.DUCKDB_LOCAL === '1';

// `base: './'` makes the build work from any path (GitHub Pages subfolder, Tauri, file server).
export default defineConfig({
  plugins: [react()],
  base: './',
  define: { __DUCKDB_LOCAL__: JSON.stringify(duckdbLocal) },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022' },
});
