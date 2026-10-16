import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['sample-khata.svg', 'icons/pakka-khata-192.png', 'icons/pakka-khata-512.png'],
      manifest: {
        name: 'Pakka Khata',
        short_name: 'Pakka Khata',
        description: 'A private digital khata book for small shops.',
        theme_color: '#F5EEDC',
        background_color: '#F5EEDC',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/pakka-khata-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/pakka-khata-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff,woff2}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [
          /^\/api(?:\/|$)/,
          /^\/docs(?:\/|$)/,
          /^\/redoc(?:\/|$)/,
          /^\/openapi\.json$/,
        ],
      },
    }),
  ],
  server: { port: 5173 },
});
