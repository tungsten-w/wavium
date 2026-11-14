// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > AI (P2-2): the AI providers Atrium itself calls (mail triage,
// summaries, drafts). Admins set providers for everyone; users may add their
// own (unless an admin turned that off). Keys are write-only: the page shows
// only "Key ••••WXYZ". "Test" lists the models and never spends tokens.
// API in aiApi.ts, form logic in aiModel.ts.
import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@atrium/sdk'
import { Badge, Button, Card, Checkbox, Dialog, EmptyState, Select, Spinner, Switch, TextField, confirmDialog, toast } from '@atrium/ui'
import { aiApi } from './aiApi'
import {
	type AiOverview, type ConnectionTest, defaultChoices, emptyForm, formError, formFromView, keyHelp, kindLabels, keyText,
	payload, type ProviderForm, type ProviderView, type Scope, testText,
} from './aiModel'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function Ai(_: { session: Session }) {
	const [data, setData] = useState<AiOverview | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [editing, setEditing] = useState<{ scope: Scope, provider: ProviderView | null } | null>(null)

	const load = useCallback(async () => {
		try {
			setData(await aiApi.overview())
			setError(null)
		} catch (e) {
			setError(errText(e))
		}
	}, [])
	useEffect(() => { void load() }, [load])

	const run = async (fn: () => Promise<unknown>) => {
		try {
			await fn()
			await load()
		} catch (e) {
			toast.error(errText(e))
		}
	}

	return (
		<section className="settings-section">
			<h2 className="at-headline">AI providers</h2>
			<p className="at-muted">The AIs Wavium itself uses: mail sorting, summaries, drafts. API keys are stored encrypted and are never shown again after saving.</p>
			{error ? <Card className="settings-block"><p>{error}</p><Button variant="tonal" onClick={() => void load()}>Retry</Button></Card>
				: !data ? <div className="settings-center"><Spinner /></div>
					: <>
						<ProviderList
							title="For everyone on this instance"
							note={data.isAdmin ? 'Every user can use these. Users do not see their address or key.' : 'Set by your admin.'}
							providers={data.instance}
							defaultId={data.effectiveDefault}
							empty={data.isAdmin ? 'No provider for the instance yet.' : 'Your admin has not set up an AI provider.'}
							onAdd={data.isAdmin ? () => setEditing({ scope: 'instance', provider: null }) : undefined}
							onEdit={(p) => setEditing({ scope: 'instance', provider: p })}
							onToggle={(p, on) => void run(() => aiApi.update(p.id, { enabled: on }))}
							onDelete={(p) => void run(async () => {
								if (await confirmDialog(`Delete "${p.label}"? Features using it stop until another provider is chosen. Its key is erased.`, { confirm: 'Delete', danger: true })) await aiApi.remove(p.id)
							})}
						/>
						{data.isAdmin && (
							<Card className="settings-block">
								<h3>Instance options</h3>
								<Select label="Default provider for everyone" value={data.instanceDefault ?? ''} onChange={(e) => void run(() => aiApi.setDefault(e.target.value || null, 'instance'))}>
									<option value="">The first one in the list</option>
									{data.instance.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
								</Select>
								<Switch label="Users may add their own providers (with their own key)" checked={data.personalProviders} onChange={(e) => void run(() => aiApi.setPersonal(e.target.checked))} />
							</Card>
						)}
						{data.personalProviders && (
							<ProviderList
								title="Your own providers"
								note="Only you can use these, with your own key and budget."
								providers={data.mine}
								defaultId={data.effectiveDefault}
								empty="You have not added a provider."
								onAdd={() => setEditing({ scope: 'user', provider: null })}
								onEdit={(p) => setEditing({ scope: 'user', provider: p })}
								onToggle={(p, on) => void run(() => aiApi.update(p.id, { enabled: on }))}
								onDelete={(p) => void run(async () => {
									if (await confirmDialog(`Delete "${p.label}"? Its key is erased.`, { confirm: 'Delete', danger: true })) await aiApi.remove(p.id)
								})}
							/>
						)}
						<Card className="settings-block">
							<h3>Used for you</h3>
							<Select label="Default provider" value={data.defaultProvider ?? ''} onChange={(e) => void run(() => aiApi.setDefault(e.target.value || null))}>
								<option value="">Follow the instance</option>
								{defaultChoices(data).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
							</Select>
							<p className="at-muted settings-note">
								{data.effectiveDefault
									? `Now: ${[...data.instance, ...data.mine].find((p) => p.id === data.effectiveDefault)?.label ?? data.effectiveDefault}.`
									: 'No usable provider: AI features stay off.'}
							</p>
						</Card>
					</>}
			{editing && data && (
				<ProviderDialog
					data={data}
					scope={editing.scope}
					provider={editing.provider}
					onClose={() => setEditing(null)}
					onSaved={() => { setEditing(null); void load() }}
				/>
			)}
		</section>
	)
}

function ProviderList(props: {
	title: string
	note: string
	providers: ProviderView[]
	defaultId: string | null
	empty: string
	onAdd?: () => void
	onEdit: (p: ProviderView) => void
	onToggle: (p: ProviderView, on: boolean) => void
	onDelete: (p: ProviderView) => void
}) {
	const [tests, setTests] = useState<Record<string, ConnectionTest | 'busy'>>({})
	const test = async (p: ProviderView) => {
		setTests((t) => ({ ...t, [p.id]: 'busy' }))
		try {
			const r = await aiApi.test({ id: p.id })
			setTests((t) => ({ ...t, [p.id]: r }))
		} catch (e) {
			setTests((t) => ({ ...t, [p.id]: { ok: false, error: { code: 'unavailable', message: errText(e) } } }))
		}
	}
	return (
		<Card className="settings-block">
			<div className="settings-head">
				<h3>{props.title}</h3>
				{props.onAdd && <Button variant="tonal" icon="add" onClick={props.onAdd}>Add a provider</Button>}
			</div>
			<p className="at-muted settings-note">{props.note}</p>
			{props.providers.length === 0 ? <EmptyState icon="plug" title={props.empty} />
				: (
					<table className="settings-table ai-table">
						<tbody>
							{props.providers.map((p) => {
								const t = tests[p.id]
								return (
									<tr key={p.id} data-provider={p.id}>
										<td>
											<div className="ai-name">{p.label} {p.id === props.defaultId && <Badge>used for you</Badge>}</div>
											<div className="at-muted ai-sub">{kindLabels[p.kind] ?? p.kind}{p.defaultModel ? ` · ${p.defaultModel}` : ''} · {keyText(p)}</div>
											{t && t !== 'busy' && <div className={t.ok ? 'ai-ok' : 'settings-bad'} role="status">{testText(t)}</div>}
										</td>
										<td className="ai-actions">
											{p.editable && <Switch aria-label={`Use ${p.label}`} checked={p.enabled} onChange={(e) => props.onToggle(p, e.target.checked)} />}
											<Button variant="text" busy={t === 'busy'} onClick={() => void test(p)}>Test</Button>
											{p.editable && <Button variant="text" onClick={() => props.onEdit(p)}>Edit</Button>}
											{p.editable && <Button variant="text" onClick={() => props.onDelete(p)}>Delete</Button>}
										</td>
									</tr>
								)
							})}
						</tbody>
					</table>
				)}
		</Card>
	)
}

function ProviderDialog({ data, scope, provider, onClose, onSaved }: {
	data: AiOverview
	scope: Scope
	provider: ProviderView | null
	onClose: () => void
	onSaved: () => void
}) {
	const [form, setForm] = useState<ProviderForm>(() => (provider ? formFromView(provider) : emptyForm(scope, data.kinds)))
	const [busy, setBusy] = useState<'save' | 'test' | null>(null)
	const [result, setResult] = useState<ConnectionTest | null>(null)
	const [error, setError] = useState<string | null>(null)
	const set = (patch: Partial<ProviderForm>) => { setForm((f) => ({ ...f, ...patch })); setResult(null); setError(null) }
	const info = data.kinds.find((k) => k.kind === form.kind)
	const problem = formError(form, data.kinds, provider)

	const test = async () => {
		if (problem) return setError(problem)
		setBusy('test')
		try {
			setResult(await aiApi.test({ ...payload(form, provider), ...(provider ? { id: provider.id } : { scope }) }))
		} catch (e) {
			setError(errText(e))
		} finally {
			setBusy(null)
		}
	}
	const save = async () => {
		if (problem) return setError(problem)
		setBusy('save')
		try {
			if (provider) await aiApi.update(provider.id, payload(form, provider))
			else await aiApi.create(payload(form, null))
			toast(provider ? 'Provider saved' : 'Provider added')
			onSaved()
		} catch (e) {
			setError(errText(e))
		} finally {
			setBusy(null)
		}
	}

	const models = result?.ok ? result.models ?? [] : []
	const listId = 'ai-models-' + (provider?.id ?? 'new')
	return (
		<Dialog
			open
			title={provider ? `Edit ${provider.label}` : scope === 'instance' ? 'Add a provider for everyone' : 'Add your own provider'}
			onClose={onClose}
			actions={<>
				<Button variant="text" onClick={onClose}>Cancel</Button>
				<Button variant="tonal" busy={busy === 'test'} disabled={busy === 'save'} onClick={() => void test()}>Test connection</Button>
				<Button busy={busy === 'save'} disabled={busy === 'test'} onClick={() => void save()}>Save</Button>
			</>}>
			<div className="ai-form">
				<Select label="Provider" value={form.kind} onChange={(e) => set({ kind: e.target.value as ProviderForm['kind'] })}>
					{data.kinds.map((k) => <option key={k.kind} value={k.kind}>{kindLabels[k.kind] ?? k.kind}</option>)}
				</Select>
				<TextField label="Name" placeholder={kindLabels[form.kind]} value={form.label} maxLength={100} onChange={(e) => set({ label: e.target.value })} />
				{form.kind !== 'mock' && (
					<TextField
						label="Base URL"
						placeholder={info?.baseUrl ?? 'https://llm.example.com/v1'}
						hint={info?.baseUrl ? 'Leave empty for the default.' : 'Required for this provider.'}
						value={form.baseUrl}
						onChange={(e) => set({ baseUrl: e.target.value })}
					/>
				)}
				{form.kind !== 'mock' && (
					<TextField
						label="API key"
						type="password"
						autoComplete="off"
						placeholder={provider?.hasKey && provider.kind === form.kind && !form.removeKey ? `Unchanged (${keyText(provider)})` : undefined}
						hint={keyHelp[form.kind]}
						value={form.apiKey}
						disabled={form.removeKey}
						onChange={(e) => set({ apiKey: e.target.value })}
					/>
				)}
				{provider?.hasKey && !info?.needsKey && form.kind !== 'mock' && (
					<Checkbox label="Remove the saved key" checked={form.removeKey} onChange={(e) => set({ removeKey: e.target.checked, apiKey: '' })} />
				)}
				<TextField label="Default model" list={listId} placeholder={form.kind === 'anthropic' ? 'e.g. claude-haiku-...' : undefined} hint={models.length ? 'Pick one from the list or type a name.' : 'Test the connection to see the available models.'} value={form.defaultModel} onChange={(e) => set({ defaultModel: e.target.value })} />
				<datalist id={listId}>{models.map((m) => <option key={m} value={m} />)}</datalist>
				<TextField label="Other models allowed (optional)" hint="Comma-separated. Empty = any model of this provider." value={form.models} onChange={(e) => set({ models: e.target.value })} />
				{result && <p className={result.ok ? 'ai-ok' : 'settings-bad'} role="status">{testText(result)}</p>}
				{error && <p className="settings-bad" role="alert">{error}</p>}
			</div>
		</Dialog>
	)
}
