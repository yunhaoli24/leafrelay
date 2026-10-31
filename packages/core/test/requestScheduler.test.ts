import { describe, expect, it, vi } from 'vitest';
import { HttpRequestScheduler } from '../src/api/requestScheduler';

describe('HttpRequestScheduler', () => {
    it('releases the shared queue when a request stalls and preserves caller cancellation', async () => {
        const requests = vi
            .fn<typeof globalThis.fetch>()
            .mockImplementationOnce(
                (_input, init) =>
                    new Promise((_resolve, reject) => {
                        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
                    }),
            )
            .mockResolvedValueOnce(new Response('next project'));
        const scheduler = new HttpRequestScheduler({ fetch: requests, minimumIntervalMs: 0, requestTimeoutMs: 25 });
        const stalled = scheduler.fetch('https://overleaf.test/project/one');
        const controller = new AbortController();
        const next = scheduler.fetch('https://overleaf.test/project/two', { signal: controller.signal });
        await expect(stalled).rejects.toThrow('timeout');
        expect(await (await next).text()).toBe('next project');
        controller.abort();
        expect(requests.mock.calls[1][1]!.signal!.aborted).toBe(true);
    });

    it('applies one rate-limit cooldown to requests from different projects', async () => {
        let now = 1000;
        const waits: number[] = [];
        const fetch = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
            .mockResolvedValueOnce(new Response('ok'));
        const scheduler = new HttpRequestScheduler({
            fetch,
            minimumIntervalMs: 100,
            now: () => now,
            wait: async (milliseconds) => {
                waits.push(milliseconds);
                now += milliseconds;
            },
        });

        const first = scheduler.fetch('https://overleaf.test/project/one/compile');
        const second = scheduler.fetch('https://overleaf.test/project/two/compile');
        await Promise.all([first, second]);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(waits).toEqual([2000]);
    });

    it('paces history requests across projects', async () => {
        let now = 0;
        const waits: number[] = [];
        const scheduler = new HttpRequestScheduler({
            fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok')),
            minimumIntervalMs: 0,
            historyIntervalMs: 3000,
            now: () => now,
            wait: async (milliseconds) => {
                waits.push(milliseconds);
                now += milliseconds;
            },
        });

        await scheduler.fetch('https://overleaf.test/project/one/filetree/diff?from=1&to=2');
        await scheduler.fetch('https://overleaf.test/project/two/updates?min_count=10');

        expect(waits).toEqual([3000]);
    });
});
