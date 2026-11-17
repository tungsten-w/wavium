// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-time codes (2FA, bank, delivery PINs) are hidden from agents by default:
// an agent that reads them can take over accounts (ADR 0010).

const WORDS = /\b(code|codes|otp|pin|passcode|password|mot de passe|v[ée]rification|verification|verify|confirm|confirmation|s[ée]curit[ée]|security|login|connexion|authenti|2fa|one[- ]time|usage unique|valid|expire|g-\d)/i
const DIGITS = /(?<![\d.,:/])(?:\d[ -]?){4,8}(?![\d,:/]|\.\d)/
const ALNUM = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{3,4}-?[A-Z0-9]{3,4}\b/

/** Whether a message looks like it carries a one-time code. */
export function isOneTimeCode(text: string): boolean {
	if (!text || text.length > 600) return false
	if (/\bG-\d{6}\b/.test(text)) return true
	return WORDS.test(text) && (DIGITS.test(text) || ALNUM.test(text))
}

export const HIDDEN_CODE = '[one-time code hidden from agents]'

/** The text an agent sees: codes replaced unless the owner allowed them. */
export function forAgent(text: string, otp: boolean, show: boolean): string {
	return otp && !show ? HIDDEN_CODE : text
}
