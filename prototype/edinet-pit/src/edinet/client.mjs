/**
 * EDINET API v2 client.
 *
 * The API delivers documents, not data: you can ask what was filed on a given
 * date and you can download a document by id, and that is all. There is no
 * cross-company search and no time series, so building anything queryable means
 * walking dates, which for ten years of history is a few thousand requests.
 *
 * That shape drives two decisions here. Requests are paced and retried
 * conservatively, because this is public infrastructure and losing access to it
 * would end the project. And the transport is injectable, so the walk, the
 * pacing and the retry logic are all testable without touching the network --
 * which is the only way they get tested at all in a sandbox that cannot reach it.
 */

import { buildUrl, createPacedRequester, HttpRequestError } from '../http/paced-requester.mjs';

const BASE_URL = 'https://api.edinet-fsa.go.jp/api/v2';

/** Metadata only, or metadata plus the document list. */
export const LIST_TYPE = { METADATA: 1, WITH_DOCUMENTS: 2 };

/** Document formats. CSV arrived in 2024 and is far cheaper to parse than XBRL. */
export const DOC_TYPE = { XBRL_ZIP: 1, PDF: 2, ALTERNATE: 3, ENGLISH: 4, CSV: 5 };

/** Kept for callers that catch by name; the shared requester raises these. */
export const EdinetError = HttpRequestError;

/**
 * @param {object} options
 * @param {string} options.subscriptionKey  EDINET API key.
 * @param {Function} [options.transport]    fetch-compatible; injected in tests.
 * @param {number} [options.minIntervalMs]  Floor on the gap between requests.
 * @param {number} [options.maxRetries]     Attempts after the first, on retryable failures only.
 * @param {Function} [options.wait]         Delay implementation; injected so tests do not sleep.
 */
export function createEdinetClient(options) {
    const { subscriptionKey, baseUrl = BASE_URL, ...requesterOptions } = options;

    if (!subscriptionKey) {
        throw new HttpRequestError('subscriptionKey is required');
    }

    const { request, stats } = createPacedRequester(requesterOptions);

    // The key rides in the query string, which is what EDINET expects.
    const call = (path, params, opts) =>
        request(buildUrl(baseUrl, path, { ...params, 'Subscription-Key': subscriptionKey }), opts);

    return {
        stats,

        /** Documents filed on one day (`YYYY-MM-DD`). */
        async listDocuments(date, type = LIST_TYPE.WITH_DOCUMENTS) {
            const body = await call('documents.json', { date, type });
            return (body.results ?? []).map(toDocumentSummary);
        },

        /** Raw bytes of one document in the requested format. */
        async fetchDocument(docId, type = DOC_TYPE.CSV) {
            return call(`documents/${docId}`, { type }, { as: 'buffer' });
        },

        /**
         * Walks a date range one day at a time, yielding each day's filings.
         *
         * A generator rather than a batch return: a ten-year backfill is hundreds
         * of thousands of documents, and the caller needs to persist each day and
         * be able to stop, not hold the whole thing in memory.
         */
        async *walkDates(fromDate, toDate, filter = () => true) {
            for (const date of eachDate(fromDate, toDate)) {
                const documents = (await this.listDocuments(date)).filter(filter);
                yield { date, documents };
            }
        },
    };
}

/** Annual report, its amendment, and the semi-annual report that replaced quarterlies. */
export const DOC_TYPE_CODE = {
    ANNUAL: '120',
    ANNUAL_AMENDMENT: '130',
    QUARTERLY: '140',
    SEMI_ANNUAL: '160',
    SEMI_ANNUAL_AMENDMENT: '170',
    EXTRAORDINARY: '180',
};

const AMENDMENT_CODES = new Set([
    DOC_TYPE_CODE.ANNUAL_AMENDMENT,
    DOC_TYPE_CODE.SEMI_ANNUAL_AMENDMENT,
    '150',
]);

/** Keeps only periodic financial filings and their amendments. */
export function isFinancialFiling(document) {
    return [
        DOC_TYPE_CODE.ANNUAL,
        DOC_TYPE_CODE.ANNUAL_AMENDMENT,
        DOC_TYPE_CODE.QUARTERLY,
        '150',
        DOC_TYPE_CODE.SEMI_ANNUAL,
        DOC_TYPE_CODE.SEMI_ANNUAL_AMENDMENT,
    ].includes(document.docTypeCode);
}

/**
 * Normalizes an API result into the shape the store records.
 *
 * submitDateTime becomes known_from, so it is the single most important field
 * here: it is when the figures in this document became knowable.
 */
export function toDocumentSummary(result) {
    const periodEnd = result.periodEnd ?? null;
    return {
        docId: result.docID,
        edinetCode: result.edinetCode,
        secCode: result.secCode ?? null,
        filerName: result.filerName ?? null,
        docTypeCode: result.docTypeCode,
        periodStart: result.periodStart ?? null,
        periodEnd,
        fiscalYear: fiscalYearOf(periodEnd),
        submittedAt: toIsoInstant(result.submitDateTime),
        isAmendment: AMENDMENT_CODES.has(result.docTypeCode),
        amendsDocId: result.parentDocID ?? null,
    };
}

/**
 * Fiscal year from the period end.
 *
 * Japanese fiscal years are named for the year they start in, so a period ending
 * in January through March belongs to the previous calendar year. Getting this
 * off by one would silently file every March-ending company's data under the
 * wrong year -- which is most of the market.
 */
export function fiscalYearOf(periodEnd) {
    if (!periodEnd) {
        return null;
    }
    const [year, month] = periodEnd.split('-').map(Number);
    if (!Number.isFinite(year) || !Number.isFinite(month)) {
        return null;
    }
    return month <= 3 ? year - 1 : year;
}

/** EDINET reports `YYYY-MM-DD HH:mm`; the store keeps ISO-8601 UTC. */
export function toIsoInstant(submitDateTime) {
    if (!submitDateTime) {
        return null;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(submitDateTime);
    if (!match) {
        return null;
    }
    const [, year, month, day, hour, minute] = match;
    // Filing times are JST (UTC+9); recording them as UTC would move a late
    // afternoon filing to the previous day and reorder the timeline.
    const utc = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour) - 9,
        Number(minute)
    );
    return new Date(utc).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Inclusive date range, one `YYYY-MM-DD` at a time. */
export function* eachDate(fromDate, toDate) {
    const start = new Date(`${fromDate}T00:00:00Z`);
    const end = new Date(`${toDate}T00:00:00Z`);

    for (let day = start; day <= end; day = new Date(day.getTime() + 86_400_000)) {
        yield day.toISOString().slice(0, 10);
    }
}
