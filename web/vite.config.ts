import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` makes the build work from any path (GitHub Pages subfolder, Tauri, file server).
export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022' },
});
