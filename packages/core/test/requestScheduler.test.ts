import {describe, expect, it, vi} from 'vitest';
import {HttpRequestScheduler} from '../src/api/requestScheduler';

describe('HttpRequestScheduler', () => {
    it('applies one rate-limit cooldown to requests from different projects', async () => {
        let now = 1000;
        const waits:number[] = [];
        const fetch = vi.fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(new Response('', {status:429, headers:{'retry-after':'2'}}))
            .mockResolvedValueOnce(new Response('ok'));
        const scheduler = new HttpRequestScheduler({
            fetch,
            minimumIntervalMs:100,
            now:() => now,
            wait:async milliseconds => { waits.push(milliseconds); now += milliseconds; },
        });

        const first = scheduler.fetch('https://overleaf.test/project/one/compile');
        const second = scheduler.fetch('https://overleaf.test/project/two/compile');
        await Promise.all([first, second]);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(waits).toEqual([2000]);
    });

    it('paces history requests across projects', async () => {
        let now = 0;
        const waits:number[] = [];
        const scheduler = new HttpRequestScheduler({
            fetch:vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok')),
            minimumIntervalMs:0,
            historyIntervalMs:3000,
            now:() => now,
            wait:async milliseconds => { waits.push(milliseconds); now += milliseconds; },
        });

        await scheduler.fetch('https://overleaf.test/project/one/filetree/diff?from=1&to=2');
        await scheduler.fetch('https://overleaf.test/project/two/updates?min_count=10');

        expect(waits).toEqual([3000]);
    });
});
