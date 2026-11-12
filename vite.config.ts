import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE: '/simple-label-printer/' when served from GitHub Pages project URL.
export default defineConfig({
	base: process.env.BASE ?? './',
	plugins: [
		VitePWA({
			registerType: 'autoUpdate',
			includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
			workbox: {
				globPatterns: ['**/*.{js,css,html,svg,png,woff2,json}'],
				navigateFallback: 'index.html'
			},
			manifest: {
				name: 'מדפסת מדבקות',
				short_name: 'מדבקות',
				description: 'הדפסת מדבקות טקסט במדפסת Supvan E10',
				lang: 'he',
				dir: 'rtl',
				display: 'standalone',
				orientation: 'portrait',
				start_url: '.',
				scope: '.',
				background_color: '#f4f5f7',
				theme_color: '#1f6feb',
				icons: [
					{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
					{ src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
				]
			}
		})
	]
});
