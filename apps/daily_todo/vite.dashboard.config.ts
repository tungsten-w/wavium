import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// The Dashboard's calendar widget: its own small script, loaded only on the Dashboard.
export default defineConfig({
	plugins: [vue()],
	define: {
		'process.env.NODE_ENV': JSON.stringify('production'),
	},
	build: {
		cssCodeSplit: false,
		emptyOutDir: false,
		lib: {
			entry: 'src/dashboard.ts',
			formats: ['iife'],
			name: 'DailyTodoDashboard',
			fileName: () => 'daily-todo-dashboard.js',
		},
		outDir: 'dist',
		rollupOptions: {
			output: {
				assetFileNames: (asset) => asset.name?.endsWith('.css')
					? 'daily-todo-dashboard.css'
					: '[name][extname]',
			},
		},
	},
})
