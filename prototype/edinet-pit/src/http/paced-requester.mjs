/**
 * Shared HTTP behaviour for the public APIs this prototype reads.
 *
 * Both EDINET and gBizINFO are government services with request limits, and
 * losing access to either would end the project, so the same discipline applies
 * to both: space requests out, back off on transient failures, and never retry
 * something the server already rejected as malformed. Rather than keep two
 * near-identical retry loops in step, they share this one.
 *
 * Everything time-related and network-related is injectable, which is what makes
 * pacing and retry testable at all without a network or real delays.
 */

export class HttpRequestError extends Error {
    constructor(message, { status, retryable } = {}) {
        super(message);
        this.name = 'HttpRequestError';
        this.status = status;
        this.retryable = retryable === true;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Only transient conditions are worth repeating. A 4xx other than 429 means the
 * request itself was wrong: retrying cannot change the outcome and just adds
 * load to a public service.
 */
export function isRetryableStatus(status) {
    return status === 429 || status >= 500;
}

/**
 * @param {object} options
 * @param {Function} [options.transport]     fetch-compatible.
 * @param {number} [options.minIntervalMs]   Floor on the gap between requests.
 * @param {number} [options.maxRetries]      Attempts after the first.
 * @param {Function} [options.wait]          Delay implementation.
 * @param {Function} [options.now]           Clock, injectable for tests.
 * @param {object} [options.headers]         Sent on every request.
 */
export function createPacedRequester(options = {}) {
    const {
        transport = globalThis.fetch,
        minIntervalMs = 250,
        maxRetries = 3,
        wait = sleep,
        now = () => Date.now(),
        headers = {},
    } = options;

    let lastRequestAt = 0;
    const stats = { requests: 0, retries: 0, waitedMs: 0 };

    async function pace() {
        const remaining = minIntervalMs - (now() - lastRequestAt);
        if (lastRequestAt !== 0 && remaining > 0) {
            stats.waitedMs += remaining;
            await wait(remaining);
        }
        lastRequestAt = now();
    }

    /**
     * @param {string} url
     * @param {object} [opts]
     * @param {'json'|'buffer'} [opts.as]  How to read a successful response.
     */
    async function request(url, { as = 'json' } = {}) {
        let lastError;

        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            if (attempt > 0) {
                stats.retries += 1;
                // 500ms, 1s, 2s.
                await wait(500 * 2 ** (attempt - 1));
            }
            await pace();
            stats.requests += 1;

            let response;
            try {
                response = await transport(url, { headers });
            } catch (error) {
                lastError = new HttpRequestError(`transport failure: ${error.message}`, {
                    retryable: true,
                });
                continue;
            }

            if (response.ok) {
                return as === 'buffer' ? await response.arrayBuffer() : await response.json();
            }

            const retryable = isRetryableStatus(response.status);
            lastError = new HttpRequestError(`responded ${response.status}`, {
                status: response.status,
                retryable,
            });
            if (!retryable) {
                throw lastError;
            }
        }

        throw lastError;
    }

    return { request, stats };
}

/**
 * Builds a URL with query parameters, dropping anything undefined or null.
 *
 * gBizINFO rejects a URL with a trailing slash outright, so paths are joined
 * without one and this is the single place that assembles them.
 */
export function buildUrl(baseUrl, path, params = {}) {
    const base = baseUrl.replace(/\/+$/, '');
    const suffix = path === '' ? '' : `/${path.replace(/^\/+|\/+$/g, '')}`;
    const url = new URL(`${base}${suffix}`);

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
            url.searchParams.set(key, String(value));
        }
    }
    return url.toString();
}
