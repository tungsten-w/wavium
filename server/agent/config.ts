// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reads what the agent layer needs from Nextcloud's config/config.php: the
// database connection and the public URL. The file is plain PHP array syntax;
// only simple scalar entries are read.

export interface NcConfig {
	dbtype: 'pgsql' | 'sqlite3' | string
	dbname: string
	dbhost: string
	dbport: string
	dbuser: string
	dbpassword: string
	dbtableprefix: string
	datadirectory: string
	baseUrl: string
	/** Instance secret (signs internal calls to PHP). */
	secret: string
}

/** Values of `'key' => 'value'` / `'key' => 123` / `'key' => true` lines (top level only). */
export function parseConfigPhp(src: string): Record<string, string> {
	const out: Record<string, string> = {}
	const re = /^\s{0,4}'([A-Za-z0-9_.\-]+)'\s*=>\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?)|(true|false))\s*,/gm
	let m: RegExpExecArray | null
	while ((m = re.exec(src)) !== null) {
		const [, key, single, double, num, bool] = m
		if (key in out) continue
		out[key] = single !== undefined ? single.replace(/\\(['\\])/g, '$1')
			: double !== undefined ? double.replace(/\\(["\\])/g, '$1')
				: num ?? bool ?? ''
	}
	return out
}

export function toNcConfig(raw: Record<string, string>, docroot: string): NcConfig {
	const host = raw.dbhost ?? 'localhost'
	// Nextcloud allows "host:port" in dbhost.
	const [h, p] = host.includes(':') && !host.startsWith('/') ? host.split(':') : [host, '']
	const base = (raw['overwrite.cli.url'] ?? 'http://localhost').replace(/\/$/, '')
	return {
		dbtype: raw.dbtype ?? 'sqlite3',
		dbname: raw.dbname ?? 'owncloud',
		dbhost: h,
		dbport: raw.dbport || p || '5432',
		dbuser: raw.dbuser ?? '',
		dbpassword: raw.dbpassword ?? '',
		dbtableprefix: raw.dbtableprefix ?? 'oc_',
		datadirectory: raw.datadirectory ?? `${docroot}/data`,
		baseUrl: base,
		secret: raw.secret ?? '',
	}
}

export async function loadNcConfig(docroot: string): Promise<NcConfig> {
	const src = await Bun.file(`${docroot}/config/config.php`).text()
	return toNcConfig(parseConfigPhp(src), docroot)
}
