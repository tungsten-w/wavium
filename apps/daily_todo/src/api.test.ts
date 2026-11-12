import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn()
vi.mock('@nextcloud/axios', () => ({ default: { get: (...a: unknown[]) => request(...a), request: (...a: unknown[]) => request(...a) } }))

beforeEach(() => {
	request.mockReset()
	;(globalThis as unknown as { OC: unknown }).OC = { generateUrl: (path: string) => path }
})

describe('api errors', () => {
	it("shows the server's own message instead of 'status code 400'", async () => {
		const { api } = await import('./api')
		request.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
			response: { data: { error: 'This day is read-only' } },
		}))
		await expect(api.complete(1, true)).rejects.toThrow('This day is read-only')
		await expect(api.day('2026-10-03')).rejects.toThrow('This day is read-only')
	})

	it('keeps the original error when the server sent no message', async () => {
		const { api } = await import('./api')
		request.mockRejectedValue(new Error('Network Error'))
		await expect(api.day('2026-10-03')).rejects.toThrow('Network Error')
	})

	it('returns the payload on success', async () => {
		const { api } = await import('./api')
		request.mockResolvedValue({ data: { ok: true } })
		await expect(api.complete(1, true)).resolves.toEqual({ ok: true })
	})
	it('sends the owner with day calls only while a shared list is open', async () => {
		const { api, board } = await import('./api')
		const calledUrls = () => request.mock.calls.map(([arg]) => typeof arg === 'string' ? arg : (arg as { url: string }).url)
		request.mockResolvedValue({ data: {} })
		board.owner = 'alice'
		try {
			await api.day('2026-10-03')
			await api.summary('2026-10')
			await api.createQuick('2026-10-03', 'x')
			await api.reorder('2026-10-03', [1])
			await api.settings()
			await api.template()
			await api.shares()
			expect(calledUrls()).toEqual([
				'/apps/daily_todo/api/day/2026-10-03?owner=alice',
				'/apps/daily_todo/api/summary/2026-10?owner=alice',
				'/apps/daily_todo/api/day/2026-10-03/quick?owner=alice',
				'/apps/daily_todo/api/day/2026-10-03/order?owner=alice',
				'/apps/daily_todo/api/settings', // your own settings, never the owner's
				'/apps/daily_todo/api/template',
				'/apps/daily_todo/api/shares',
			])
			request.mockClear()
			board.owner = null
			await api.day('2026-10-03')
			expect(calledUrls()).toEqual(['/apps/daily_todo/api/day/2026-10-03'])
		} finally {
			board.owner = null
		}
	})
})
