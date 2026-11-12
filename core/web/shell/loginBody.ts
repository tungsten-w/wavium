// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Builds the form body for POST /login. `rememberme` must be sent for the server
// to set the long-lived login cookie; without it the session ends when the
// browser closes or the 24h session lifetime runs out.
export interface LoginInput {
	user: string
	password: string
	remember: boolean
	timezone: string
	timezoneOffset: number
	requesttoken: string
	redirect?: string | null
}

export function loginBody(i: LoginInput): URLSearchParams {
	const body = new URLSearchParams({
		user: i.user,
		password: i.password,
		timezone: i.timezone,
		timezone_offset: String(i.timezoneOffset),
		requesttoken: i.requesttoken,
	})
	if (i.remember) body.set('rememberme', '1')
	if (i.redirect) body.set('redirect_url', i.redirect)
	return body
}
