import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Proxy /api → backend so we don't need to bake hostnames into the SPA.
// VITE_API_URL still works (used directly by the axios client) if you'd rather
// hit the backend at a fixed URL instead of going through the proxy.
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        port: 5173,
        host: true,
        proxy: {
            '/api': {
                target: 'http://localhost:4000',
                changeOrigin: true,
                ws: true,
            },
        },
    },
});
