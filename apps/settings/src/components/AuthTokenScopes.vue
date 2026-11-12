<!--
  - SPDX-FileCopyrightText: 2026 Atrium contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<fieldset class="token-scopes" :disabled="disabled">
		<legend class="hidden-visually">
			{{ t('settings', 'Permissions') }}
		</legend>
		<component
			:is="group.other ? 'details' : 'div'"
			v-for="group in groups"
			:key="group.other ? 'other' : 'main'"
			:open="group.other ? otherOpen : undefined"
			class="token-scopes__group">
			<summary v-if="group.other" class="token-scopes__summary">
				{{ t('settings', 'Other apps ({count})', { count: Object.keys(group.rows).length }) }}
			</summary>
			<table>
				<tbody>
					<tr v-for="(actions, area) in group.rows" :key="area" class="token-scopes__row">
						<th scope="row" class="token-scopes__area">
							{{ areaLabel(area) }}
						</th>
						<td class="token-scopes__actions">
							<label
								v-for="action in actions"
								:key="action"
								class="token-scopes__action"
								:class="{ 'token-scopes__action--sensitive': isSensitive(action) }">
								<input
									type="checkbox"
									:checked="isChecked(area, action)"
									:disabled="!isAllowed(area, action)"
									:data-scope="`${area}:${action}`"
									@change="onChange(area, action, $event)">
								{{ actionLabel(action) }}
							</label>
						</td>
					</tr>
				</tbody>
			</table>
		</component>
		<p v-if="Object.keys(rows).length === 0" class="token-scopes__empty">
			{{ t('settings', 'Nothing left to remove.') }}
		</p>
	</fieldset>
</template>

<script lang="ts">
import type { PropType } from 'vue'

import { translate as t } from '@nextcloud/l10n'
import { defineComponent } from 'vue'
import { actionLabel, areaLabel, areasFor, MAIN_AREAS, SENSITIVE_ACTIONS } from '../utils/tokenScopes.ts'

/**
 * Area x action grid. Works on an explicit "area:action" list: write ticks
 * read too, unticking read unticks write. With `limit`, only those scopes
 * are shown and can stay ticked (used to narrow an existing token).
 */
export default defineComponent({
	name: 'AuthTokenScopes',

	model: {
		prop: 'value',
		event: 'input',
	},

	props: {
		value: {
			type: Array as PropType<string[]>,
			required: true,
		},

		agent: {
			type: Boolean,
			default: false,
		},

		limit: {
			type: Array as PropType<string[] | null>,
			default: null,
		},

		disabled: {
			type: Boolean,
			default: false,
		},
	},

	emits: ['input'],

	computed: {
		rows(): Record<string, string[]> {
			const areas = areasFor(this.agent)
			if (this.limit === null) {
				return areas
			}
			const rows: Record<string, string[]> = {}
			for (const scope of this.limit) {
				const [area, action] = scope.split(':', 2)
				rows[area] = [...(rows[area] ?? []), action]
			}
			for (const area of Object.keys(rows)) {
				const known = areas[area] ?? []
				const rank = (action: string) => (known.includes(action) ? known.indexOf(action) : known.length)
				rows[area].sort((a, b) => rank(a) - rank(b))
			}
			return rows
		},

		/** Main areas first (in MAIN_AREAS order), every other app folded below. */
		groups(): { other: boolean, rows: Record<string, string[]> }[] {
			const main: Record<string, string[]> = {}
			const other: Record<string, string[]> = {}
			for (const area of MAIN_AREAS) {
				if (this.rows[area]) {
					main[area] = this.rows[area]
				}
			}
			for (const [area, actions] of Object.entries(this.rows)) {
				if (!MAIN_AREAS.includes(area)) {
					other[area] = actions
				}
			}
			const groups = [{ other: false, rows: main }]
			if (Object.keys(other).length > 0) {
				groups.push({ other: true, rows: other })
			}
			return groups
		},

		/** Unfold "Other apps" when something there is ticked or when narrowing. */
		otherOpen(): boolean {
			return this.limit !== null || this.value.some((s) => !MAIN_AREAS.includes(s.split(':')[0]))
		},
	},

	methods: {
		t,
		areaLabel,
		actionLabel,

		isSensitive(action: string): boolean {
			return SENSITIVE_ACTIONS.includes(action)
		},

		isChecked(area: string, action: string): boolean {
			return this.value.includes(`${area}:${action}`)
		},

		isAllowed(area: string, action: string): boolean {
			return this.limit === null || this.limit.includes(`${area}:${action}`)
		},

		onChange(area: string, action: string, event: Event) {
			this.toggle(area, action, (event.target as HTMLInputElement).checked)
		},

		toggle(area: string, action: string, checked: boolean) {
			const next = new Set(this.value)
			if (checked) {
				next.add(`${area}:${action}`)
				if (action === 'write' && this.isAllowed(area, 'read')) {
					next.add(`${area}:read`)
				}
			} else {
				next.delete(`${area}:${action}`)
				if (action === 'read') {
					next.delete(`${area}:write`)
				}
			}
			this.$emit('input', [...next])
		},
	},
})
</script>

<style lang="scss" scoped>
.token-scopes {
	border: none;
	padding: 0;
	margin: 0;

	table {
		border-collapse: collapse;
		width: 100%;
	}

	&__row {
		border-bottom: 1px solid var(--color-border);
	}

	&__area {
		text-align: start;
		font-weight: normal;
		padding: 6px 12px 6px 0;
		white-space: normal;
		width: 40%;
		vertical-align: middle;
	}

	&__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		padding: 6px 0;
	}

	&__action {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		cursor: pointer;

		input {
			margin: 0;
			cursor: pointer;
		}

		&--sensitive {
			color: var(--color-warning-text);
			font-weight: bold;
		}
	}

	&__group + &__group {
		margin-top: 8px;
	}

	&__summary {
		cursor: pointer;
		padding: 6px 0;
		color: var(--color-text-maxcontrast);
	}

	&__empty {
		color: var(--color-text-maxcontrast);
	}
}
</style>
