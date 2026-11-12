<!--
  - SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<form
		id="generate-app-token-section"
		@submit.prevent="submit">
		<!-- Port to TextField component when available -->
		<NcTextField
			v-model="deviceName"
			type="text"
			:maxlength="120"
			:disabled="loading"
			class="app-name-text-field"
			:label="t('settings', 'App name')"
			:placeholder="t('settings', 'App name')" />

		<!-- Atrium: scoped and agent app passwords -->
		<NcCheckboxRadioSwitch
			:model-value="limited"
			:disabled="loading"
			type="switch"
			@update:modelValue="setLimited">
			{{ t('settings', 'Limit what this app password can do') }}
		</NcCheckboxRadioSwitch>
		<template v-if="limited">
			<NcCheckboxRadioSwitch
				:model-value="agent"
				:disabled="loading"
				type="switch"
				@update:modelValue="setAgent">
				{{ t('settings', 'For an AI agent') }}
			</NcCheckboxRadioSwitch>
			<p class="scope-hint">
				<template v-if="agent">
					{{ t('settings', 'Agent app passwords never get administration or security, cannot create app passwords, and every action is granted on its own. Send, delete and share are highlighted: anything outward-facing or destructive needs its own tick.') }}
				</template>
				<template v-else>
					{{ t('settings', 'Write includes read. Send, delete and share are highlighted: they are never included in another action.') }}
				</template>
			</p>
			<AuthTokenScopes
				:value="scopes"
				:agent="agent"
				:disabled="loading"
				@input="scopes = $event" />
		</template>

		<NcButton
			variant="primary"
			:disabled="loading || deviceName.length === 0 || (limited && scopes.length === 0)"
			type="submit">
			{{ t('settings', 'Create new app password') }}
		</NcButton>

		<AuthTokenSetupDialog :token="newToken" @close="newToken = null" />
	</form>
</template>

<script lang="ts">
import type { ITokenResponse } from '../store/authtoken.ts'

import { showError } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
import { defineComponent } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import AuthTokenScopes from './AuthTokenScopes.vue'
import AuthTokenSetupDialog from './AuthTokenSetupDialog.vue'
import logger from '../logger.ts'
import { useAuthTokenStore } from '../store/authtoken.ts'
import { AGENT_FORBIDDEN, compactScopes } from '../utils/tokenScopes.ts'

export default defineComponent({
	name: 'AuthTokenSetup',
	components: {
		AuthTokenScopes,
		NcButton,
		NcCheckboxRadioSwitch,
		NcTextField,
		AuthTokenSetupDialog,
	},

	setup() {
		const authTokenStore = useAuthTokenStore()
		return { authTokenStore }
	},

	data() {
		return {
			deviceName: '',
			loading: false,
			newToken: null as ITokenResponse | null,
			limited: false,
			agent: false,
			scopes: [] as string[],
		}
	},

	methods: {
		t,
		reset() {
			this.loading = false
			this.deviceName = ''
			this.newToken = null
			this.limited = false
			this.agent = false
			this.scopes = []
		},

		setLimited(value: boolean) {
			this.limited = value
			if (!value) {
				this.agent = false
				this.scopes = []
			}
		},

		setAgent(value: boolean) {
			this.agent = value
			if (value) {
				this.scopes = this.scopes.filter((s) => !AGENT_FORBIDDEN.includes(s.split(':')[0]))
			}
		},

		async submit() {
			try {
				this.loading = true
				const scopes = this.limited ? compactScopes(this.scopes) : null
				this.newToken = await this.authTokenStore.addToken(this.deviceName, scopes, this.limited && this.agent)
				if (this.newToken === null) {
					throw new Error('App password not created')
				}
				this.limited = false
				this.agent = false
				this.scopes = []
			} catch (error) {
				logger.error(error as Error)
				showError(t('settings', 'Error while creating device token'))
				this.reset()
			} finally {
				this.loading = false
			}
		},
	},
})
</script>

<style lang="scss" scoped>
	#generate-app-token-section {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 560px;
		padding-top: 16px;
	}

	.scope-hint {
		color: var(--color-text-maxcontrast);
	}
</style>
