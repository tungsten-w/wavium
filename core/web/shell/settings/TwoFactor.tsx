// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Two-factor authentication (personal Security). Kept simple:
//   GET  /ocs/v2.php/core/atrium/twofactor           providers, enabled flags, backup code counts
//   POST /ocs/v2.php/core/atrium/twofactor/disable   { provider } (password confirmation, strict)
//   POST /apps/twofactor_backupcodes/settings/create new backup codes, shown once (password confirmation)
// Setting up other providers (authenticator app etc.) is their own UI; those stay in the classic page.
import { useState } from 'react'
import { confirmPassword, HttpError, ocs, request, useAsync, type Session } from '@atrium/sdk'
import { Button, Card, Dialog, Icon, Spinner, confirmDialog, toast } from '@atrium/ui'

interface Provider { id: string, name: string, description: string, enabled: boolean }
interface State { enforced: boolean, providers: Provider[], backupCodes: { enabled: boolean, total: number, used: number } | null }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const cancelled = (e: unknown) => e instanceof HttpError && e.status === 0

export function TwoFactor({ session, onClassic }: { session: Session, onClassic: () => void }) {
	const { data, error, loading, reload } = useAsync(() => ocs<State>('core/atrium/twofactor'), [])
	const [codes, setCodes] = useState<string[] | null>(null)
	const [busy, setBusy] = useState<string | null>(null)

	async function generate() {
		const had = !!data?.backupCodes?.enabled
		if (had && !(await confirmDialog('Generate new backup codes? The old ones stop working.', { confirm: 'Generate', danger: true }))) return
		setBusy('codes')
		try {
			const auth = await confirmPassword(session.user.id, 'Confirm your password to generate backup codes.')
			const res = await request<{ codes: string[] }>('/apps/twofactor_backupcodes/settings/create', { method: 'POST', body: {}, headers: auth })
			setCodes(res.codes)
			reload()
		} catch (e) {
			if (!cancelled(e)) toast.error(errText(e))
		}
		setBusy(null)
	}

	async function disable(p: Provider) {
		if (!(await confirmDialog(`Turn off "${p.name}"?`, { confirm: 'Turn off', danger: true }))) return
		setBusy(p.id)
		try {
			const auth = await confirmPassword(session.user.id, 'Confirm your password to turn off two-factor.')
			await ocs('core/atrium/twofactor/disable', { method: 'POST', body: { provider: p.id }, headers: auth })
			toast(`${p.name} turned off`)
			reload()
		} catch (e) {
			if (!cancelled(e)) toast.error(errText(e))
		}
		setBusy(null)
	}

	const anyOn = data?.providers.some((p) => p.enabled) ?? false
	const bc = data?.backupCodes
	return (
		<Card className="settings-block">
			<h3>Two-factor authentication</h3>
			<p className="at-muted" style={{ marginTop: 0 }}>
				{loading && !data ? 'Loading...' : anyOn ? 'Two-factor is on: signing in also asks for a second code.' : 'Two-factor is off: your password is all that signs you in.'}
				{data?.enforced && ' Your administrator requires it.'}
			</p>
			{loading && !data ? <Spinner /> : error ? <p className="settings-bad">{error.message}</p> : data && (
				<>
					<ul className="settings-checks" style={{ marginBottom: 12 }}>
						{data.providers.map((p) => (
							<li key={p.id} className="settings-check settings-check--info" style={{ alignItems: 'center' }}>
								<Icon name={p.enabled ? 'check' : 'lock'} />
								<div style={{ flex: 1 }}>
									<strong>{p.name}</strong>
									<p style={{ margin: 0 }}>
										{p.id === 'backup_codes' && bc
											? bc.enabled ? `${bc.total - bc.used} of ${bc.total} codes left` : 'No codes generated yet'
											: p.enabled ? 'Enabled' : 'Off'}
									</p>
								</div>
								{p.id === 'backup_codes'
									? <Button variant="tonal" busy={busy === 'codes'} onClick={generate}>{bc?.enabled ? 'Regenerate' : 'Generate codes'}</Button>
									: p.enabled
										? <Button variant="text" busy={busy === p.id} onClick={() => disable(p)}>Turn off</Button>
										: <Button variant="text" onClick={onClassic}>Set up</Button>}
								{p.id === 'backup_codes' && p.enabled && <Button variant="text" busy={busy === p.id} onClick={() => disable(p)}>Turn off</Button>}
							</li>
						))}
						{!data.providers.length && <li className="at-muted">No two-factor provider is installed.</li>}
					</ul>
					{!data.providers.some((p) => p.id !== 'backup_codes') && (
						<p className="at-muted" style={{ margin: 0, fontSize: 13 }}>
							No authenticator app (TOTP) provider is installed, so backup codes are the only option. Install a two-factor app from Apps to add one.
						</p>
					)}
				</>
			)}
			<Dialog open={!!codes} title="Your backup codes" onClose={() => setCodes(null)} actions={<Button onClick={() => setCodes(null)}>Done</Button>}>
				<p className="at-muted" style={{ marginTop: 0 }}>Each code works once. Save them now, they are not shown again.</p>
				<pre className="settings-codes">{codes?.join('\n')}</pre>
				<div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
					<Button variant="tonal" icon="contentCopy" onClick={() => { void navigator.clipboard?.writeText(codes?.join('\n') ?? ''); toast('Copied') }}>Copy</Button>
					<Button variant="tonal" icon="download" onClick={() => {
						const a = document.createElement('a')
						a.href = URL.createObjectURL(new Blob([(codes ?? []).join('\n') + '\n'], { type: 'text/plain' }))
						a.download = 'backup-codes.txt'
						a.click()
						URL.revokeObjectURL(a.href)
					}}>Download</Button>
				</div>
			</Dialog>
		</Card>
	)
}
