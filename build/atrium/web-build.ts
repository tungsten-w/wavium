// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Builds every Atrium frontend with Bun. No central list: apps are discovered.
//   core/web           -> core/web/dist (vendor React, @atrium/ui, @atrium/sdk, shell, index.html)
//   apps/<id>/web      -> apps/<id>/web/dist (index.js [+ index.css], manifest.json)
// Apps import react, @atrium/ui and @atrium/sdk; those stay external and resolve
// through the shell's import map, so each app build is small and independent.
//
//   bun build/atrium/web-build.ts            build everything
//   bun build/atrium/web-build.ts --watch    rebuild on change (dev container)
//   bun build/atrium/web-build.ts daily_todo build one app
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'

const root = join(import.meta.dir, '../..')
const core = join(root, 'core/web')
const out = join(core, 'dist')
const prod = process.env.NODE_ENV !== 'development'
const shared = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@atrium/ui', '@atrium/sdk']

interface AppManifest {
	/** Route the UI owns: /apps/<route>/... (defaults to the app id). */
	route: string
	app: string
	entry: string
	css: string[]
	hash: string
	/** Classic app whose navigation entry this UI takes over. */
	replaces?: string
}

function hashOf(files: string[]): string {
	const h = new Bun.CryptoHasher('sha256')
	for (const f of files) if (existsSync(f)) h.update(readFileSync(f))
	return h.digest('hex').slice(0, 10)
}

async function bundle(opts: { entry: string, outdir: string, naming: string, external?: string[], label: string }) {
	const res = await Bun.build({
		entrypoints: [opts.entry],
		outdir: opts.outdir,
		naming: opts.naming,
		target: 'browser',
		format: 'esm',
		minify: prod,
		sourcemap: prod ? 'linked' : 'inline',
		external: opts.external ?? [],
		define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') },
		jsx: { runtime: 'automatic', importSource: 'react', development: false },
	})
	if (!res.success) {
		for (const l of res.logs) console.error(l)
		throw new Error(`build failed: ${opts.label}`)
	}
	return res.outputs.map((o) => o.path)
}

// React is CommonJS on npm. Bundle it once (vendor/all.js, no externals), then
// expose each specifier as a tiny ESM facade with real named exports.
async function buildVendor(): Promise<string[]> {
	const req = createRequire(join(core, 'package.json'))
	const dir = join(core, '.vendor')
	mkdirSync(dir, { recursive: true })
	const mods: Record<string, string> = { react: 'react', reactDom: 'react-dom', client: 'react-dom/client', jsx: 'react/jsx-runtime' }
	writeFileSync(join(dir, 'all.ts'), Object.entries(mods).map(([n, s]) => `import * as ${n} from '${s}';`).join('\n') + `\nexport { ${Object.keys(mods).join(', ')} };\n`)
	await bundle({ entry: join(dir, 'all.ts'), outdir: join(out, 'vendor'), naming: 'all.js', label: 'vendor' })
	const v = hashOf([join(out, 'vendor/all.js')])
	const files: Record<string, string> = { react: 'react.js', reactDom: 'react-dom.js', client: 'react-dom-client.js', jsx: 'react-jsx-runtime.js' }
	for (const [n, spec] of Object.entries(mods)) {
		const keys = Object.keys(req(spec)).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default')
		writeFileSync(join(out, 'vendor', files[n]), `import { ${n} as m } from './all.js?v=${v}';\nconst d = m.default ?? m;\nexport default d;\nexport const { ${keys.join(', ')} } = d;\n`)
	}
	return Object.values(files).map((f) => join(out, 'vendor', f))
}

async function buildCore() {
	rmSync(out, { recursive: true, force: true })
	mkdirSync(out, { recursive: true })
	await buildVendor()
	await bundle({ entry: join(core, 'ui/index.tsx'), outdir: out, naming: 'ui.js', external: shared.filter((s) => s !== '@atrium/ui'), label: 'ui' })
	await Bun.write(join(out, 'ui.css'), Bun.file(join(core, 'ui/ui.css')))
	await bundle({ entry: join(core, 'sdk/index.ts'), outdir: out, naming: 'sdk.js', external: shared.filter((s) => s !== '@atrium/sdk'), label: 'sdk' })
	await bundle({ entry: join(core, 'shell/main.tsx'), outdir: out, naming: 'shell.js', external: shared, label: 'shell' })
	if (existsSync(join(core, 'shell/shell.css'))) await Bun.write(join(out, 'shell.css'), Bun.file(join(core, 'shell/shell.css')))

	const v = hashOf(['vendor/all.js', 'vendor/react.js', 'vendor/react-dom.js', 'vendor/react-dom-client.js', 'vendor/react-jsx-runtime.js', 'ui.js', 'sdk.js', 'shell.js', 'ui.css', 'shell.css'].map((f) => join(out, f)))
	const importMap = {
		imports: {
			react: `/core/web/dist/vendor/react.js?v=${v}`,
			'react-dom': `/core/web/dist/vendor/react-dom.js?v=${v}`,
			'react-dom/client': `/core/web/dist/vendor/react-dom-client.js?v=${v}`,
			'react/jsx-runtime': `/core/web/dist/vendor/react-jsx-runtime.js?v=${v}`,
			'@atrium/ui': `/core/web/dist/ui.js?v=${v}`,
			'@atrium/sdk': `/core/web/dist/sdk.js?v=${v}`,
		},
	}
	const html = readFileSync(join(core, 'shell/index.html'), 'utf8')
		.replace('<!--importmap-->', `<script type="importmap">${JSON.stringify(importMap)}</script>`)
		.replaceAll('__V__', v)
	writeFileSync(join(out, 'index.html'), html)
	console.log(`core/web: built (v=${v})`)
}

function appDirs(): { id: string, dir: string }[] {
	const list: { id: string, dir: string }[] = []
	for (const base of ['apps']) {
		const p = join(root, base)
		if (!existsSync(p)) continue
		for (const id of readdirSync(p)) {
			const dir = join(p, id, 'web')
			if (existsSync(join(dir, 'index.tsx')) || existsSync(join(dir, 'index.ts'))) list.push({ id, dir })
		}
	}
	return list
}

async function buildApp(id: string, dir: string): Promise<AppManifest> {
	const dist = join(dir, 'dist')
	rmSync(dist, { recursive: true, force: true })
	const entry = existsSync(join(dir, 'index.tsx')) ? join(dir, 'index.tsx') : join(dir, 'index.ts')
	const files = await bundle({ entry, outdir: dist, naming: '[name].[ext]', external: shared, label: id })
	const meta = existsSync(join(dir, 'web.json')) ? JSON.parse(readFileSync(join(dir, 'web.json'), 'utf8')) : {}
	const css = files.filter((f) => f.endsWith('.css')).map((f) => relative(dist, f))
	const manifest: AppManifest = { route: meta.route ?? id, app: id, entry: 'index.js', css, hash: hashOf(files), ...(meta.replaces ? { replaces: meta.replaces } : {}) }
	writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, '\t'))
	console.log(`apps/${id}/web: built (route /apps/${manifest.route}, ${manifest.hash})`)
	return manifest
}

/** Index of every app UI, read by the shell (core/web/dist/apps.json). */
function writeIndex() {
	const index: Record<string, AppManifest & { url: string }> = {}
	for (const { id, dir } of appDirs()) {
		const m = join(dir, 'dist/manifest.json')
		if (!existsSync(m)) continue
		const man: AppManifest = JSON.parse(readFileSync(m, 'utf8'))
		index[man.route] = { ...man, url: `/apps/${id}/web/dist/` }
	}
	mkdirSync(out, { recursive: true })
	writeFileSync(join(out, 'apps.json'), JSON.stringify(index, null, '\t'))
}

async function buildAll(only?: string) {
	const t = performance.now()
	if (!only) await buildCore()
	for (const { id, dir } of appDirs()) if (!only || only === id) await buildApp(id, dir)
	writeIndex()
	console.log(`done in ${Math.round(performance.now() - t)}ms`)
}

const args = process.argv.slice(2)
const only = args.find((a) => !a.startsWith('--'))
await buildAll(only)

if (args.includes('--watch')) {
	let timer: Timer | null = null
	const pending = new Set<string>()
	const schedule = (what: string) => {
		pending.add(what)
		timer && clearTimeout(timer)
		timer = setTimeout(async () => {
			const jobs = [...pending]
			pending.clear()
			try {
				if (jobs.includes('core')) await buildAll()
				else { for (const id of jobs) { const d = appDirs().find((a) => a.id === id); if (d) await buildApp(d.id, d.dir) } writeIndex() }
			} catch (e) { console.error(String(e)) }
		}, 150)
	}
	const watchDir = (dir: string, what: string) => watch(dir, { recursive: true }, (_e, f) => { if (f && !String(f).includes('dist') && !String(f).includes('.vendor')) schedule(what) })
	for (const d of ['ui', 'sdk', 'shell']) if (existsSync(join(core, d))) watchDir(join(core, d), 'core')
	for (const { id, dir } of appDirs()) watchDir(dir, id)
	console.log('watching for changes')
	void statSync
}
