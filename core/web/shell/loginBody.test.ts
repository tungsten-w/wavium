import { describe, expect, it } from 'vitest'
import { loginBody } from './loginBody'

const base = { user: 'a', password: 'b', timezone: 'UTC', timezoneOffset: 0, requesttoken: 't' }

describe('loginBody', () => {
	it('sends rememberme=1 when staying signed in', () => {
		expect(loginBody({ ...base, remember: true }).get('rememberme')).toBe('1')
	})
	it('omits rememberme when not remembering', () => {
		expect(loginBody({ ...base, remember: false }).has('rememberme')).toBe(false)
	})
	it('includes redirect_url only when given', () => {
		expect(loginBody({ ...base, remember: true, redirect: '/apps/x' }).get('redirect_url')).toBe('/apps/x')
		expect(loginBody({ ...base, remember: true }).has('redirect_url')).toBe(false)
	})
})
