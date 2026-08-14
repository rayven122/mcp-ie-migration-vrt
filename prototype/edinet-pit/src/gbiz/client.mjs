/**
 * gBizINFO REST API v2 client.
 *
 * Keyed entirely on the 13-digit corporate number, which is also published in
 * EDINET's code list -- so the two datasets join on a real identifier and nothing
 * here ever needs to match companies by name.
 *
 * The ingestion shape matters more than the endpoints. Polling every target
 * company across all nine categories would be roughly 30,000 x 9 requests a day
 * and would exhaust any request limit immediately. v2 publishes period-scoped
 * update feeds instead, so the daily job pulls nine feeds, intersects the changed
 * corporate numbers with the companies we care about, and fetches detail only for
 * that intersection: nine requests plus the actual changes.
 *
 * Those feeds also report *when* each record changed, which is what lets gBizINFO
 * data participate in point-in-time reads at all. Administrative records are
 * revised in place with no version of their own, so without a change time there
 * would be no way to avoid leaking a later revision into an earlier as_of.
 */

import { buildUrl, createPacedRequester, HttpRequestError } from '../http/paced-requester.mjs';

const BASE_URL = 'https://api.info.gbiz.go.jp/hojin';
export const API_VERSION = 'v2';

/** Categories, in the order the endpoints name them. '' is the basic record. */
export const CATEGORIES = [
    '',
    'certification',
    'commendation',
    'corporation',
    'finance',
    'patent',
    'procurement',
    'subsidy',
    'workplace',
];

export const GbizError = HttpRequestError;

/**
 * @param {object} options
 * @param {string} options.apiToken        Token from the Web API application.
 *                                         Never the demo token published on the
 *                                         Swagger page -- that is scoped to that
 *                                         page only.
 * @param {Function} [options.transport]   fetch-compatible; injected in tests.
 */
export function createGbizClient(options) {
    const { apiToken, baseUrl = BASE_URL, ...requesterOptions } = options;

    if (!apiToken) {
        throw new HttpRequestError('apiToken is required');
    }

    const { request, stats } = createPacedRequester({
        ...requesterOptions,
        headers: { 'X-hojinInfo-api-token': apiToken },
    });

    // A trailing slash makes gBizINFO reject the request outright, so paths are
    // always assembled without one.
    const path = (category, suffix = '') => {
        const parts = ['v2', 'hojin', suffix, category].filter((part) => part !== '');
        return parts.join('/');
    };

    return {
        stats,

        /** One company's records in one category. */
        async getCategory(corporateNumber, category = '') {
            const body = await request(buildUrl(baseUrl, path(category, corporateNumber)));
            return extractRecords(body);
        },

        /**
         * Corporate numbers whose records in `category` changed in the window.
         *
         * This is the cheap half of the sync: nine of these calls replace hundreds
         * of thousands of per-company polls.
         */
        async listUpdated(category = '', { from, to, page } = {}) {
            const body = await request(
                buildUrl(baseUrl, path(category, 'updateInfo'), {
                    from_date: from,
                    to_date: to,
                    page,
                })
            );
            return extractRecords(body);
        },

        /**
         * Fetches detail only for companies we track that actually changed.
         *
         * Yields per company so the caller can persist incrementally and stop; a
         * batch return would mean holding a day's worth of records in memory and
         * losing all of it on any failure.
         */
        async *syncCategory(category, { from, to, targetNumbers }) {
            const targets = targetNumbers instanceof Set ? targetNumbers : new Set(targetNumbers);
            const updated = await this.listUpdated(category, { from, to });

            const changed = [
                ...new Set(
                    updated
                        .map((record) => record.corporateNumber)
                        .filter((number) => number && targets.has(number))
                ),
            ];

            for (const corporateNumber of changed) {
                yield {
                    corporateNumber,
                    category,
                    records: await this.getCategory(corporateNumber, category),
                };
            }
        },
    };
}

/**
 * Pulls the record array out of a response.
 *
 * The exact envelope key is unverified against the live v2 service -- v1 used
 * `hojin-infos` -- so the plausible shapes are accepted rather than guessing one
 * and returning nothing when it turns out to be another. An unrecognized shape
 * throws instead of yielding an empty list, because "no records" and "we could not
 * read the response" must not look the same to the caller.
 */
export function extractRecords(body) {
    if (Array.isArray(body)) {
        return body.map(normalizeRecord);
    }
    for (const key of ['hojin-infos', 'hojinInfos', 'results', 'items']) {
        if (Array.isArray(body?.[key])) {
            return body[key].map(normalizeRecord);
        }
    }
    if (body && typeof body === 'object' && Object.keys(body).length === 0) {
        return [];
    }
    throw new HttpRequestError(
        `unrecognized gBizINFO response shape: keys ${Object.keys(body ?? {}).join(', ') || 'none'}`
    );
}

/** Maps the fields we rely on, keeping the untouched original alongside. */
export function normalizeRecord(record) {
    return {
        corporateNumber: record.corporate_number ?? record.corporateNumber ?? null,
        name: record.name ?? record.corporate_name ?? null,
        updatedAt: record.update_date ?? record.updateDate ?? null,
        raw: record,
    };
}

/**
 * Derives the row stored in gbiz_facts for one record in one category.
 *
 * `recordKey` has to be stable across fetches or re-syncing would append
 * duplicates instead of updating. Where the payload offers no obvious identifier,
 * the composite of the fields that identify the event is used.
 */
export function toGbizFact(corporateNumber, category, record, { fetchedAt }) {
    const raw = record.raw ?? record;
    const amount =
        toNumber(raw.amount) ??
        toNumber(raw.subsidy_amount) ??
        toNumber(raw.joint_signature) ??
        null;
    const eventDate =
        raw.date_of_approval ?? raw.date_of_award ?? raw.date ?? record.updatedAt ?? null;
    const title = raw.title ?? raw.subsidy_resource ?? raw.name ?? null;
    const agency = raw.government_departments ?? raw.agency ?? null;

    return {
        corporateNumber,
        category: category === '' ? 'basic' : category,
        recordKey:
            raw.id ??
            raw.key ??
            ([eventDate ?? '', title ?? '', agency ?? ''].join('|') || 'record'),
        eventDate,
        amount,
        agency,
        title,
        raw: JSON.stringify(raw),
        fetchedAt,
        apiVersion: API_VERSION,
    };
}

function toNumber(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const parsed = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
}
