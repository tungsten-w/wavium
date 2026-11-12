/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Entries of the classic (Vue) frontend, discovered from apps/<id>/web/legacy.json
 * (and core/web/legacy.json) instead of a central list. Used by
 * build/frontend/vite.config.ts ("vite") and build/frontend-legacy/webpack.modules.cjs
 * ("webpack"). Sources are resolved through <buildDir>/apps/<id> symlinks so
 * imports keep resolving node_modules from the build dir; missing symlinks are
 * created here, so adding an app needs no build config change.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')

/**
 * @param {'vite' | 'webpack'} kind
 * @param {string} buildDir directory of the calling config
 * @return {Record<string, Record<string, string>>} appId -> entry name -> absolute path
 */
function legacyEntries(kind, buildDir) {
	const out = {}
	const add = (id, file, link, target) => {
		if (!fs.existsSync(file)) return
		const map = JSON.parse(fs.readFileSync(file, 'utf8'))[kind]
		if (!map || Object.keys(map).length === 0) return
		ensureLink(link, target)
		out[id] = Object.fromEntries(Object.entries(map).map(([name, rel]) => [name, path.join(link, rel)]))
	}
	add('core', path.join(root, 'core/web/legacy.json'), path.join(buildDir, 'core'), path.join(root, 'core'))
	for (const id of fs.readdirSync(path.join(root, 'apps')).sort()) {
		add(id, path.join(root, 'apps', id, 'web/legacy.json'), path.join(buildDir, 'apps', id), path.join(root, 'apps', id))
	}
	return out
}

function ensureLink(link, target) {
	try {
		fs.lstatSync(link)
		return
	} catch {}
	fs.mkdirSync(path.dirname(link), { recursive: true })
	fs.symlinkSync(path.relative(path.dirname(link), target), link)
}

module.exports = { legacyEntries }
