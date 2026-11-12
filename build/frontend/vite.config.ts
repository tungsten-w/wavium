/*!
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: CC0-1.0
 */

import { createAppConfig } from '@nextcloud/vite-config'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

// Atrium: no central list. Each app declares its entries in apps/<id>/web/legacy.json.
const modules: Record<string, Record<string, string>> = createRequire(import.meta.url)('../atrium/legacy-entries.cjs').legacyEntries('vite', import.meta.dirname)

// convert modules to modules entries prefied with the app id
const viteModuleEntries = Object.entries(modules)
	.map(([appId, entries]) => (
		Object.entries(entries)
			.map(([entryName, entryPath]) => [`${appId}-${entryName}`, entryPath])
	))
	.flat(1)

export default createAppConfig(Object.fromEntries(viteModuleEntries), {
	createEmptyCSSEntryPoints: true,
	emptyOutputDirectory: {
		additionalDirectories: [resolve(import.meta.dirname, '../..', 'dist')],
	},
	extractLicenseInformation: {
		includeSourceMaps: true,
	},
	config: {
		root: resolve(import.meta.dirname, '../..'),
		resolve: {
			preserveSymlinks: true,
		},
		build: {
			outDir: 'dist',
			rollupOptions: {
				output: {
					entryFileNames: '[name].mjs',
					chunkFileNames: '[name]-[hash].chunk.mjs',
					assetFileNames({ originalFileNames }) {
						const apps = originalFileNames.map((name) => name.match(/apps\/([^/]+)\//)?.[1])
							.filter(Boolean)
						const appId = apps.length === 1 ? apps[0] : 'common'
						return `${appId}-[name]-[hash][extname]`
					},
					experimentalMinChunkSize: 100 * 1024,
					/* // with rolldown-vite:
					advancedChunks: {
						groups: [
							// one group for common dependencies
							{ name: 'common', test: /[\\/]node_modules[\\/]/ },
							// one group per app with a lower minShareCount to encourage sharing within the app
							...Object.keys(modules).map((name) => ({
								name,
								test: new RegExp(`[\\\\/]apps[\\\\/]${name}[\\\\/]`),
								minShareCount: 2,
							})),
						],
						// only include modules in the groups if they are used at least by 3 different chunks
						minShareCount: 3,
						// only include modules in the groups if they are smaller than 400kb on its own
						// maxModuleSize: 400 * 1024,
						// define the groups output size (not too small but also not too big!)
						minSize: 100 * 1024,
						maxSize: 800 * 1024,
					},
				},
				experimental: {
					strictExecutionOrder: true,
				},
					*/
				},
			},
		},
		experimental: {
			renderBuiltUrl(filename, { hostType }) {
				if (hostType === 'css') {
					return `./${filename}`
				}
				return {
					runtime: `window.OC.filePath('', '', 'dist/${filename}')`,
				}
			},
		},
	},
})
