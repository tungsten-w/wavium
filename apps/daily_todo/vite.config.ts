import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [vue()],
	define: {
		'process.env.NODE_ENV': JSON.stringify('production'),
	},
	build: {
		cssCodeSplit: false,
		emptyOutDir: false,
		lib: {
			entry: 'src/main.ts',
			formats: ['iife'],
			name: 'DailyTodo',
			fileName: () => 'daily-todo.js',
		},
		outDir: 'dist',
		rollupOptions: {
			output: {
				assetFileNames: (asset) => asset.name?.endsWith('.css')
					? 'daily-todo.css'
					: '[name][extname]',
			},
		},
	},
})
