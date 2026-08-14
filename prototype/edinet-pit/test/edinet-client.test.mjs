import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    createEdinetClient,
    DOC_TYPE,
    eachDate,
    fiscalYearOf,
    isFinancialFiling,
    toDocumentSummary,
    toIsoInstant,
} from '../src/edinet/client.mjs';

/** Records every URL requested and replays scripted responses. */
function stubTransport(script) {
    const calls = [];
    const queue = [...script];

    const transport = async (url) => {
        calls.push(url);
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) {
            throw next;
        }
        return {
            ok: next.status === undefined || (next.status >= 200 && next.status < 300),
            status: next.status ?? 200,
            json: async () => next.body,
            arrayBuffer: async () => next.buffer ?? new ArrayBuffer(0),
        };
    };

    return { transport, calls };
}

/** Never actually sleeps; records what the client asked to wait. */
function fakeClock() {
    const waits = [];
    return { waits, wait: async (ms) => void waits.push(ms) };
}

const RESULT = {
    docID: 'S100ORIG',
    edinetCode: 'E99999',
    secCode: '99990',
    filerName: 'テスト株式会社',
    docTypeCode: '120',
    periodStart: '2023-04-01',
    periodEnd: '2024-03-31',
    submitDateTime: '2024-06-20 15:30',
};

describe('document summaries', () => {
    test('an API result maps onto what the store records', () => {
        const summary = toDocumentSummary(RESULT);

        assert.equal(summary.docId, 'S100ORIG');
        assert.equal(summary.edinetCode, 'E99999');
        assert.equal(summary.fiscalYear, 2023);
        assert.equal(summary.isAmendment, false);
    });

    test('amendment document types are recognized', () => {
        assert.equal(toDocumentSummary({ ...RESULT, docTypeCode: '130' }).isAmendment, true);
        assert.equal(toDocumentSummary({ ...RESULT, docTypeCode: '170' }).isAmendment, true);
    });

    // A March year end is the common case in Japan, and naming it 2024 instead of
    // 2023 would misfile most of the market by a year.
    test('fiscal years are named for the year the period started', () => {
        assert.equal(fiscalYearOf('2024-03-31'), 2023);
        assert.equal(fiscalYearOf('2024-01-31'), 2023);
        assert.equal(fiscalYearOf('2024-04-30'), 2024);
        assert.equal(fiscalYearOf('2024-12-31'), 2024);
        assert.equal(fiscalYearOf(null), null);
    });

    // known_from comes from this value, so a timezone slip would reorder the
    // knowledge timeline a correction sits on.
    test('filing times convert from JST to UTC', () => {
        assert.equal(toIsoInstant('2024-06-20 15:30'), '2024-06-20T06:30:00Z');
        // An early-morning JST filing belongs to the previous UTC day.
        assert.equal(toIsoInstant('2024-06-20 08:00'), '2024-06-19T23:00:00Z');
        assert.equal(toIsoInstant(''), null);
        assert.equal(toIsoInstant('nonsense'), null);
    });

    test('only periodic financial filings pass the filter', () => {
        assert.equal(isFinancialFiling({ docTypeCode: '120' }), true);
        assert.equal(isFinancialFiling({ docTypeCode: '130' }), true);
        assert.equal(isFinancialFiling({ docTypeCode: '160' }), true);
        assert.equal(isFinancialFiling({ docTypeCode: '180' }), false);
        assert.equal(isFinancialFiling({ docTypeCode: '350' }), false);
    });
});

describe('date walking', () => {
    test('the range is inclusive at both ends', () => {
        assert.deepEqual(
            [...eachDate('2024-06-19', '2024-06-21')],
            ['2024-06-19', '2024-06-20', '2024-06-21']
        );
    });

    test('month and year boundaries are crossed correctly', () => {
        assert.deepEqual(
            [...eachDate('2024-02-28', '2024-03-01')],
            ['2024-02-28', '2024-02-29', '2024-03-01']
        );
        assert.deepEqual([...eachDate('2024-12-31', '2025-01-01')], ['2024-12-31', '2025-01-01']);
    });

    test('a single-day range yields that day', () => {
        assert.deepEqual([...eachDate('2024-06-20', '2024-06-20')], ['2024-06-20']);
    });
});

describe('client requests', () => {
    test('the key and parameters are sent, and results are mapped', async () => {
        const { transport, calls } = stubTransport([{ body: { results: [RESULT] } }]);
        const client = createEdinetClient({
            subscriptionKey: 'test-key',
            transport,
            minIntervalMs: 0,
        });

        const documents = await client.listDocuments('2024-06-20');

        assert.equal(documents.length, 1);
        assert.equal(documents[0].docId, 'S100ORIG');
        assert.match(calls[0], /\/documents\.json\?/);
        assert.match(calls[0], /date=2024-06-20/);
        assert.match(calls[0], /Subscription-Key=test-key/);
    });

    test('an empty day is not an error', async () => {
        const { transport } = stubTransport([{ body: {} }]);
        const client = createEdinetClient({
            subscriptionKey: 'k',
            transport,
            minIntervalMs: 0,
        });

        assert.deepEqual(await client.listDocuments('2024-01-01'), []);
    });

    test('a document is fetched in the requested format', async () => {
        const buffer = new TextEncoder().encode('csv').buffer;
        const { transport, calls } = stubTransport([{ buffer }]);
        const client = createEdinetClient({
            subscriptionKey: 'k',
            transport,
            minIntervalMs: 0,
        });

        const bytes = await client.fetchDocument('S100ORIG', DOC_TYPE.CSV);

        assert.equal(new TextDecoder().decode(bytes), 'csv');
        assert.match(calls[0], /\/documents\/S100ORIG\?type=5/);
    });

    test('a missing key is refused up front', () => {
        assert.throws(() => createEdinetClient({}), /subscriptionKey is required/);
    });
});

describe('pacing and retry', () => {
    // This is public infrastructure; hammering it risks losing access entirely.
    test('consecutive requests are spaced by the configured interval', async () => {
        const { transport } = stubTransport([{ body: { results: [] } }]);
        const clock = fakeClock();
        const client = createEdinetClient({
            subscriptionKey: 'k',
            transport,
            minIntervalMs: 250,
            wait: clock.wait,
        });

        await client.listDocuments('2024-06-20');
        await client.listDocuments('2024-06-21');

        assert.ok(clock.waits.length >= 1, 'the second request should have waited');
        assert.ok(clock.waits.every((ms) => ms <= 250));
    });

    test('a server error is retried with growing backoff', async () => {
        const { transport, calls } = stubTransport([
            { status: 503 },
            { status: 503 },
            { body: { results: [RESULT] } },
        ]);
        const clock = fakeClock();
        const client = createEdinetClient({
            subscriptionKey: 'k',
            transport,
            minIntervalMs: 0,
            wait: clock.wait,
        });

        const documents = await client.listDocuments('2024-06-20');

        assert.equal(documents.length, 1);
        assert.equal(calls.length, 3);
        assert.deepEqual(
            clock.waits.filter((ms) => ms >= 500),
            [500, 1000]
        );
    });

    test('a transport failure is retried', async () => {
        const { transport, calls } = stubTransport([
            new Error('socket hang up'),
            { body: { results: [] } },
        ]);
        const client = createEdinetClient({
            subscriptionKey: 'k',
            transport,
            minIntervalMs: 0,
            wait: async () => {},
        });

        await client.listDocuments('2024-06-20');
        assert.equal(calls.length, 2);
    });

    // Repeating a request the server already rejected as malformed only adds
    // load; it will fail the same way every time.
    test('a client error fails immediately without retrying', async () => {
        const { transport, calls } = stubTransport([{ status: 400 }]);
        const client = createEdinetClient({
            subscriptionKey: 'k',
            transport,
            minIntervalMs: 0,
            wait: async () => {},
        });

        await assert.rejects(() => client.listDocuments('nonsense'), /responded 400/);
        assert.equal(calls.length, 1, 'a 400 must not be retried');
    });

    test('retries are bounded and the last error surfaces', async () => {
        const { transport, calls } = stubTransport([{ status: 500 }]);
        const client = createEdinetClient({
            subscriptionKey: 'k',
            transport,
            minIntervalMs: 0,
            maxRetries: 2,
            wait: async () => {},
        });

        await assert.rejects(() => client.listDocuments('2024-06-20'), /responded 500/);
        assert.equal(calls.length, 3, 'first attempt plus two retries');
    });

    test('rate limiting is treated as retryable', async () => {
        const { transport, calls } = stubTransport([{ status: 429 }, { body: { results: [] } }]);
        const client = createEdinetClient({
            subscriptionKey: 'k',
            transport,
            minIntervalMs: 0,
            wait: async () => {},
        });

        await client.listDocuments('2024-06-20');
        assert.equal(calls.length, 2);
    });
});

describe('walking a range for backfill', () => {
    test('each day is yielded with its filtered filings', async () => {
        const { transport } = stubTransport([
            { body: { results: [RESULT, { ...RESULT, docID: 'X', docTypeCode: '180' }] } },
        ]);
        const client = createEdinetClient({
            subscriptionKey: 'k',
            transport,
            minIntervalMs: 0,
            wait: async () => {},
        });

        const days = [];
        for await (const day of client.walkDates('2024-06-20', '2024-06-22', isFinancialFiling)) {
            days.push(day);
        }

        assert.equal(days.length, 3);
        assert.deepEqual(
            days.map((day) => day.date),
            ['2024-06-20', '2024-06-21', '2024-06-22']
        );
        // The extraordinary report is filtered out of every day.
        assert.ok(days.every((day) => day.documents.every((doc) => doc.docTypeCode === '120')));
    });

    test('a caller can stop partway without fetching the rest', async () => {
        const { transport, calls } = stubTransport([{ body: { results: [] } }]);
        const client = createEdinetClient({
            subscriptionKey: 'k',
            transport,
            minIntervalMs: 0,
            wait: async () => {},
        });

        for await (const _day of client.walkDates('2024-01-01', '2024-12-31')) {
            break;
        }

        assert.equal(calls.length, 1, 'stopping must not keep requesting');
    });
});
