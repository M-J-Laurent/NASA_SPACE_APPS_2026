import { defineConfig } from 'vite';

// In dev, precomputed data comes from the Python backend (data/processed).
export default defineConfig({
  server: { proxy: { '/data': 'http://localhost:8000', '/api': 'http://localhost:8000' } },
});
