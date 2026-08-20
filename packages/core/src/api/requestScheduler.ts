import {log} from '../core/logger';

export interface HttpRequestSchedulerOptions {
    minimumIntervalMs?:number;
    historyIntervalMs?:number;
    fetch?:typeof fetch;
    now?:() => number;
    wait?:(milliseconds:number) => Promise<void>;
    onRateLimit?:(until:number) => void;
}

function retryAfterMilliseconds(response:Response, now:number):number {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) { return Math.max(1000, seconds*1000); }
        const retryAt = Date.parse(retryAfter);
        if (Number.isFinite(retryAt)) { return Math.max(1000, retryAt-now); }
    }
    return 5000;
}

export class HttpRequestScheduler {
    private chain:Promise<void> = Promise.resolve();
    private nextRequestAt = 0;
    private historyNextRequestAt = 0;
    private rateLimitedUntil = 0;
    private readonly minimumIntervalMs:number;
    private readonly historyIntervalMs:number;
    private readonly fetchImplementation:typeof fetch;
    private readonly now:() => number;
    private readonly wait:(milliseconds:number) => Promise<void>;

    constructor(private readonly options:HttpRequestSchedulerOptions={}) {
        this.minimumIntervalMs = options.minimumIntervalMs ?? 300;
        this.historyIntervalMs = options.historyIntervalMs ?? 3000;
        this.fetchImplementation = options.fetch ?? fetch;
        this.now = options.now ?? Date.now;
        this.wait = options.wait ?? (milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)));
    }

    fetch(input:string|URL|Request, init?:RequestInit):Promise<Response> {
        const url = input instanceof Request ? input.url : String(input);
        const history = url.includes('/updates?') || url.includes('/filetree/diff?') || url.includes('/diff?');
        return this.enqueue(async () => {
            const now = this.now();
            const readyAt = Math.max(this.nextRequestAt, this.rateLimitedUntil, history ? this.historyNextRequestAt : 0);
            if (readyAt>now) { await this.wait(readyAt-now); }
            const requestAt = this.now();
            this.nextRequestAt = requestAt+this.minimumIntervalMs;
            if (history) { this.historyNextRequestAt = requestAt+this.historyIntervalMs; }
            const response = await this.fetchImplementation(input, init);
            if (response.status===429) {
                this.rateLimitedUntil = Math.max(
                    this.rateLimitedUntil,
                    this.now()+retryAfterMilliseconds(response, this.now()),
                );
                this.options.onRateLimit?.(this.rateLimitedUntil);
                log(`HTTP request scheduler entered rate-limit cooldown until ${new Date(this.rateLimitedUntil).toISOString()}.`);
            }
            return response;
        });
    }

    private enqueue<T>(operation:() => Promise<T>):Promise<T> {
        const result = this.chain.then(operation);
        this.chain = result.then(() => undefined, () => undefined);
        return result;
    }
}

export const sharedHttpRequestScheduler = new HttpRequestScheduler();
