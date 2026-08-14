import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { createEdinetClient } from '../src/edinet/client.mjs';
import { ingestDocument, ingestRange, summarizeIngest } from '../src/ingest.mjs';
import { detectAccountingBasis } from '../src/normalize/index.mjs';
import { getFinancials, getRestatements } from '../src/query/financials.mjs';
import { openDatabase } from '../src/store/db.mjs';

/** Encodes as UTF-16LE with a BOM, the way EDINET ships type=5 documents. */
function utf16le(text) {
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        bytes[2 + i * 2] = code & 0xff;
        bytes[3 + i * 2] = code >> 8;
    }
    return bytes;
}

const HEADER = [
    '要素ID',
    '項目名',
    'コンテキストID',
    '相対年度',
    '連結・個別',
    '期間・時点',
    'ユニットID',
    '単位',
    '値',
].join('\t');

function csv(rows) {
    return [HEADER, ...rows.map((row) => row.join('\t'))].join('\r\n');
}

function row(
    elementId,
    value,
    { context = 'CurrentYearDuration', year = '当期', cons = '連結' } = {}
) {
    return [elementId, '項目', context, year, cons, '期間', 'JPY', '百万円', value];
}

const ORIGINAL_CSV = csv([
    row('jppfs_cor:NetSales', '45000'),
    row('jppfs_cor:OperatingIncome', '5300'),
    row('jppfs_cor:NetSales', '12000', {
        context: 'CurrentYearDuration_NonConsolidatedMember',
        cons: '個別',
    }),
    row('jppfs_cor:NetSales', '31000', { context: 'CurrentYearDuration_AutoMember' }),
]);

const AMENDED_CSV = csv([
    row('jppfs_cor:NetSales', '44100'),
    row('jppfs_cor:OperatingIncome', '5300'),
]);

const IFRS_CSV = csv([
    row('jpigp_cor:RevenueIFRS', '80000'),
    row('jpigp_cor:ProfitLossIFRS', '9100'),
    row('E01234-000:TotalAssetsIFRS', '150000'),
]);

const LISTINGS = {
    '2024-06-20': [
        {
            docID: 'S100ORIG',
            edinetCode: 'E99999',
            docTypeCode: '120',
            periodStart: '2023-04-01',
            periodEnd: '2024-03-31',
            submitDateTime: '2024-06-20 15:30',
        },
    ],
    '2024-11-05': [
        {
            docID: 'S100AMND',
            edinetCode: 'E99999',
            docTypeCode: '130',
            periodStart: '2023-04-01',
            periodEnd: '2024-03-31',
            submitDateTime: '2024-11-05 10:00',
            parentDocID: 'S100ORIG',
        },
        {
            docID: 'S100EXTRA',
            edinetCode: 'E99999',
            docTypeCode: '180',
            periodEnd: '2024-03-31',
            submitDateTime: '2024-11-05 11:00',
        },
    ],
};

const DOCUMENTS = {
    S100ORIG: utf16le(ORIGINAL_CSV),
    S100AMND: utf16le(AMENDED_CSV),
    S100IFRS: utf16le(IFRS_CSV),
};

/** Serves the fixtures above through the client's transport seam. */
function fixtureClient({ broken = new Set() } = {}) {
    const fetched = [];

    const transport = async (url) => {
        const parsed = new URL(url);

        if (parsed.pathname.endsWith('/documents.json')) {
            const date = parsed.searchParams.get('date');
            return {
                ok: true,
                status: 200,
                json: async () => ({ results: LISTINGS[date] ?? [] }),
            };
        }

        const docId = parsed.pathname.split('/').pop();
        fetched.push(docId);

        if (broken.has(docId)) {
            return { ok: true, status: 200, arrayBuffer: async () => utf16le('nonsense').buffer };
        }
        const bytes = DOCUMENTS[docId];
        if (!bytes) {
            return { ok: false, status: 404 };
        }
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
    };

    return {
        fetched,
        client: createEdinetClient({
            subscriptionKey: 'k',
            transport,
            minIntervalMs: 0,
            wait: async () => {},
        }),
    };
}

describe('accounting basis detection', () => {
    // Nothing states the basis in a readable field, and applying the JP GAAP
    // mapping list to an IFRS filing resolves almost nothing.
    test('the dominant taxonomy namespace decides', () => {
        assert.equal(
            detectAccountingBasis([
                { elementId: 'jppfs_cor:NetSales' },
                { elementId: 'jppfs_cor:Assets' },
            ]),
            'jp_gaap'
        );
        assert.equal(
            detectAccountingBasis([
                { elementId: 'jpigp_cor:RevenueIFRS' },
                { elementId: 'jpigp_cor:ProfitLossIFRS' },
            ]),
            'ifrs'
        );
    });

    // An IFRS filing still carries some jppfs_cor elements, so first-match would
    // misclassify it.
    test('a minority of JP GAAP elements does not flip an IFRS filing', () => {
        const basis = detectAccountingBasis([
            { elementId: 'jpigp_cor:RevenueIFRS' },
            { elementId: 'jpigp_cor:ProfitLossIFRS' },
            { elementId: 'jpigp_cor:TotalAssetsIFRS' },
            { elementId: 'jppfs_cor:NumberOfShares' },
        ]);
        assert.equal(basis, 'ifrs');
    });

    test('an unrecognizable filing falls back rather than guessing wildly', () => {
        assert.equal(detectAccountingBasis([{ elementId: 'unknown:Thing' }]), 'jp_gaap');
        assert.equal(detectAccountingBasis([], 'ifrs'), 'ifrs');
    });
});

describe('the whole path, from document bytes to a point-in-time read', () => {
    let db;

    beforeEach(() => {
        db = openDatabase(':memory:');
    });

    // Every stage is unit tested; this is the seam test that would catch an
    // encoding, column-name or context mismatch between them.
    test('ingesting a range yields as_of reads that differ across a correction', async () => {
        const { client } = fixtureClient();

        const days = [];
        for await (const day of ingestRange(db, client, {
            from: '2024-06-20',
            to: '2024-11-05',
        })) {
            days.push(day);
        }

        const before = getFinancials(db, {
            companyIds: ['E99999'],
            fields: ['net_sales'],
            fiscalYears: [2023],
            asOf: '2024-08-01T00:00:00Z',
        });
        const after = getFinancials(db, {
            companyIds: ['E99999'],
            fields: ['net_sales'],
            fiscalYears: [2023],
            asOf: '2025-01-01T00:00:00Z',
        });

        assert.equal(before.rows[0].value, 45_000_000_000);
        assert.equal(after.rows[0].value, 44_100_000_000);
        assert.equal(before.rows[0].laterRestated, true);

        const [event] = getRestatements(db, { companyIds: ['E99999'] });
        assert.equal(event.fieldKey, 'net_sales');
        // The filing time is JST, so known_from is nine hours earlier in UTC.
        assert.equal(event.restatedAt, '2024-11-05T01:00:00Z');

        const summary = summarizeIngest(days);
        assert.equal(summary.documents, 2, 'the extraordinary report is filtered out');
        assert.equal(summary.failed, 0);
    });

    test('the fiscal year comes from the period end, not the filing date', async () => {
        const { client } = fixtureClient();
        const [document] = await client.listDocuments('2024-06-20');

        const result = await ingestDocument(db, client, document);
        assert.equal(result.facts > 0, true);

        const rows = getFinancials(db, { companyIds: ['E99999'] }).rows;
        // Filed in June 2024 for a period ending March 2024, which is FY2023.
        assert.ok(rows.every((row) => row.fiscalYear === 2023));
    });

    test('parent-only figures survive the whole path', async () => {
        const { client } = fixtureClient();
        const [document] = await client.listDocuments('2024-06-20');
        await ingestDocument(db, client, document);

        const parentOnly = getFinancials(db, {
            companyIds: ['E99999'],
            fields: ['net_sales'],
            consolidated: false,
        });
        assert.equal(parentOnly.rows[0].value, 12_000_000_000);
    });

    test('an IFRS filing is detected and mapped without being told', async () => {
        const { client } = fixtureClient();
        const document = {
            docId: 'S100IFRS',
            edinetCode: 'E88888',
            docTypeCode: '120',
            periodEnd: '2024-12-31',
            fiscalYear: 2024,
            submittedAt: '2025-03-25T00:00:00Z',
            isAmendment: false,
        };

        const result = await ingestDocument(db, client, document);

        assert.equal(result.accountingBasis, 'ifrs');
        const rows = getFinancials(db, { companyIds: ['E88888'] }).rows;
        const byField = Object.fromEntries(rows.map((row) => [row.fieldKey, row.value]));

        assert.equal(byField.net_sales, 80_000_000_000);
        assert.equal(byField.profit_loss, 9_100_000_000);
        // Resolved by pattern from a company extension element.
        assert.equal(byField.total_assets, 150_000_000_000);
        assert.equal(rows.find((row) => row.fieldKey === 'total_assets').mappingLayer, 'layer2');
    });

    test('re-ingesting a range changes nothing', async () => {
        const { client } = fixtureClient();
        const options = { from: '2024-06-20', to: '2024-11-05' };

        for await (const _day of ingestRange(db, client, options)) {
            // drain
        }
        const first = getFinancials(db, { companyIds: ['E99999'] }).rows;

        for await (const _day of ingestRange(db, client, options)) {
            // drain again
        }
        const second = getFinancials(db, { companyIds: ['E99999'] }).rows;

        assert.deepEqual(second, first);
    });

    // known_from has nowhere to go without a filing time, and inventing one would
    // corrupt every as_of read for that company.
    test('a document with no filing time is skipped, not guessed at', async () => {
        const { client, fetched } = fixtureClient();
        const result = await ingestDocument(db, client, {
            docId: 'S100ORIG',
            edinetCode: 'E99999',
            docTypeCode: '120',
            fiscalYear: 2023,
            submittedAt: null,
            isAmendment: false,
        });

        assert.match(result.skippedReason, /submitted time/);
        assert.equal(result.facts, 0);
        assert.equal(fetched.length, 0, 'it should not even be downloaded');
    });

    // One unreadable document must not discard the rest of the day's work.
    test('an unreadable document is reported and the walk continues', async () => {
        const { client } = fixtureClient({ broken: new Set(['S100AMND']) });

        const days = [];
        for await (const day of ingestRange(db, client, {
            from: '2024-06-20',
            to: '2024-11-05',
        })) {
            days.push(day);
        }

        const summary = summarizeIngest(days);
        assert.equal(summary.failed, 1);
        assert.ok(summary.facts > 0, 'the readable document still landed');

        // Without the amendment, the current view is the original figure.
        const current = getFinancials(db, {
            companyIds: ['E99999'],
            fields: ['net_sales'],
            fiscalYears: [2023],
        });
        assert.equal(current.rows[0].value, 45_000_000_000);
    });

    test('the summary surfaces the elements most often unmapped', async () => {
        const { client } = fixtureClient();
        const days = [];
        for await (const day of ingestRange(db, client, {
            from: '2024-06-20',
            to: '2024-06-20',
        })) {
            days.push(day);
        }

        const summary = summarizeIngest(days);
        // The segment row is a context skip, not an unmapped element.
        assert.equal(summary.skippedRows.context, 1);
        assert.deepEqual(summary.topUnmapped, []);
    });
});

describe('resumable backfill', () => {
    let db;

    beforeEach(() => {
        db = openDatabase(':memory:');
    });

    async function drain(client, options) {
        const days = [];
        for await (const day of ingestRange(db, client, options)) {
            days.push(day);
        }
        return days;
    }

    test('a finished day is recorded', async () => {
        const { client } = fixtureClient();
        await drain(client, { from: '2024-06-20', to: '2024-06-20' });

        const [row] = db.all('SELECT date, status, documents, facts FROM ingest_progress');
        assert.equal(row.date, '2024-06-20');
        assert.equal(row.status, 'completed');
        assert.equal(row.documents, 1);
        assert.ok(row.facts > 0);
    });

    // A ten-year backfill will be interrupted. Starting over would re-download
    // everything already held, against a public service.
    test('a second run skips days already completed', async () => {
        const first = fixtureClient();
        await drain(first.client, { from: '2024-06-20', to: '2024-06-20' });
        assert.ok(first.fetched.length > 0);

        const second = fixtureClient();
        const days = await drain(second.client, { from: '2024-06-20', to: '2024-06-20' });

        assert.deepEqual(
            days.map((day) => day.skipped),
            [true]
        );
        assert.equal(second.fetched.length, 0, 'a completed day must not be downloaded again');
    });

    test('resuming continues from where it stopped and completes the range', async () => {
        const first = fixtureClient();
        await drain(first.client, { from: '2024-06-20', to: '2024-06-20' });

        const second = fixtureClient();
        const days = await drain(second.client, { from: '2024-06-20', to: '2024-11-05' });

        assert.equal(days.length, 139);
        assert.equal(days[0].skipped, true, 'the already-finished day is skipped');
        assert.equal(
            days.filter((day) => day.results.some((result) => result.facts > 0)).length,
            1,
            'the amendment day is still ingested'
        );
        assert.ok(second.fetched.includes('S100AMND'));
        assert.ok(!second.fetched.includes('S100ORIG'));
    });

    // A day that had failures is not finished: a retry has to try it again rather
    // than accept a partial result as the whole day.
    test('a day with failures is marked partial and retried', async () => {
        const broken = fixtureClient({ broken: new Set(['S100AMND']) });
        await drain(broken.client, { from: '2024-11-05', to: '2024-11-05' });

        const [row] = db.all('SELECT status, failed FROM ingest_progress');
        assert.equal(row.status, 'partial');
        assert.equal(row.failed, 1);

        const retry = fixtureClient();
        const days = await drain(retry.client, { from: '2024-11-05', to: '2024-11-05' });

        assert.equal(days[0].skipped, false, 'a partial day must be attempted again');
        assert.ok(retry.fetched.includes('S100AMND'));
    });

    test('force re-ingests completed days, idempotently', async () => {
        const first = fixtureClient();
        await drain(first.client, { from: '2024-06-20', to: '2024-11-05' });
        const before = getFinancials(db, { companyIds: ['E99999'] });

        const forced = fixtureClient();
        const days = await drain(forced.client, {
            from: '2024-06-20',
            to: '2024-11-05',
            force: true,
        });

        assert.ok(days.every((day) => day.skipped === false));
        assert.ok(forced.fetched.includes('S100ORIG'));
        assert.deepEqual(getFinancials(db, { companyIds: ['E99999'] }), before);
    });

    test('the summary counts skipped days separately', async () => {
        const first = fixtureClient();
        await drain(first.client, { from: '2024-06-20', to: '2024-06-20' });

        const second = fixtureClient();
        const summary = summarizeIngest(
            await drain(second.client, { from: '2024-06-20', to: '2024-06-21' })
        );

        assert.equal(summary.days, 2);
        assert.equal(summary.skippedDays, 1);
    });
});
