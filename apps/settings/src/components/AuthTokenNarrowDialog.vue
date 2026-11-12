<!--
  - SPDX-FileCopyrightText: 2026 Atrium contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script setup lang="ts">
import type { IDialogButton } from '@nextcloud/dialogs'
import type { IToken } from '../store/authtoken.ts'

import { translate as t } from '@nextcloud/l10n'
import { computed, ref } from 'vue'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import AuthTokenScopes from './AuthTokenScopes.vue'
import { atriumScope, compactScopes, expandScopes } from '../utils/tokenScopes.ts'

const props = defineProps<{
	/** The scoped token being narrowed */
	token: IToken
	/** Whether the dialog is open */
	open: boolean
}>()

const emit = defineEmits<{
	'update:open': [open: boolean]
	confirm: [scopes: string[]]
}>()

const atrium = computed(() => atriumScope(props.token.scope)!)
/** Everything the token holds now, wildcards expanded: the upper bound. */
const current = computed(() => expandScopes(atrium.value.scopes, atrium.value.agent))
const selected = ref<string[]>([...current.value])

const removed = computed(() => current.value.filter((s) => !selected.value.includes(s)))

const buttons = computed<IDialogButton[]>(() => [
	{
		label: t('settings', 'Cancel'),
		variant: 'tertiary',
		callback: () => emit('update:open', false),
	},
	{
		label: t('settings', 'Remove {count} permission(s)', { count: removed.value.length }),
		variant: 'error',
		disabled: removed.value.length === 0,
		callback: () => {
			emit('confirm', compactScopes(selected.value))
			emit('update:open', false)
		},
	},
])
</script>

<template>
	<NcDialog
		:open="open"
		:name="t('settings', 'Remove permissions from {name}', { name: token.name })"
		:buttons="buttons"
		size="normal"
		@update:open="emit('update:open', $event)">
		<p class="auth-token-narrow-dialog__body">
			{{ t('settings', 'Untick what this app password should no longer do. It keeps working with the rest. To grant more, create a new app password.') }}
		</p>
		<AuthTokenScopes
			:value="selected"
			:agent="atrium.agent"
			:limit="current"
			@input="selected = $event" />
	</NcDialog>
</template>

<style lang="scss" scoped>
.auth-token-narrow-dialog__body {
	margin-block: calc(var(--default-grid-baseline) * 2);
}
</style>
