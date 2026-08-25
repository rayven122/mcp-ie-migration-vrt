import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
    createGbizClient,
    extractRecords,
    normalizeRecord,
    toGbizFact,
} from '../src/gbiz/client.mjs';
import { openDatabase } from '../src/store/db.mjs';
import {
    aggregateGbizByGroup,
    estimateProcurementExposure,
    getGroupCorporateNumbers,
    recordGbizFacts,
    recordGroupMembers,
    upsertCompany,
} from '../src/store/gbiz.mjs';

const PARENT = '1180301018771';
const RESEARCH_SUBSIDIARY = '3010001008633';
const SALES_SUBSIDIARY = '6010401021349';

function stubTransport(script) {
    const calls = [];
    const queue = [...script];

    const transport = async (url, init) => {
        calls.push({ url, headers: init?.headers ?? {} });
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) {
            throw next;
        }
        return {
            ok: next.status === undefined || (next.status >= 200 && next.status < 300),
            status: next.status ?? 200,
            json: async () => next.body,
            arrayBuffer: async () => new ArrayBuffer(0),
        };
    };

    return { transport, calls };
}

function client(script, overrides = {}) {
    const { transport, calls } = stubTransport(script);
    return {
        calls,
        gbiz: createGbizClient({
            apiToken: 'own-token',
            transport,
            minIntervalMs: 0,
            wait: async () => {},
            ...overrides,
        }),
    };
}

describe('request construction', () => {
    test('the token travels in the documented header', async () => {
        const { gbiz, calls } = client([{ body: { 'hojin-infos': [] } }]);
        await gbiz.getCategory(PARENT, 'subsidy');

        assert.equal(calls[0].headers['X-hojinInfo-api-token'], 'own-token');
    });

    // gBizINFO rejects a URL with a trailing slash outright.
    test('no path ever ends in a slash', async () => {
        const { gbiz, calls } = client([{ body: { 'hojin-infos': [] } }]);

        await gbiz.getCategory(PARENT, '');
        await gbiz.getCategory(PARENT, 'patent');
        await gbiz.listUpdated('subsidy', { from: '2026-08-01', to: '2026-08-14' });

        for (const call of calls) {
            const path = new URL(call.url).pathname;
            assert.ok(!path.endsWith('/'), `trailing slash in ${path}`);
        }
    });

    test('paths follow the v2 layout', async () => {
        const { gbiz, calls } = client([{ body: { 'hojin-infos': [] } }]);

        await gbiz.getCategory(PARENT, '');
        await gbiz.getCategory(PARENT, 'procurement');
        await gbiz.listUpdated('', { from: '2026-08-01', to: '2026-08-14' });
        await gbiz.listUpdated('workplace', { from: '2026-08-01', to: '2026-08-14' });

        const paths = calls.map((call) => new URL(call.url).pathname);
        assert.deepEqual(paths, [
            `/hojin/v2/hojin/${PARENT}`,
            `/hojin/v2/hojin/${PARENT}/procurement`,
            '/hojin/v2/hojin/updateInfo',
            '/hojin/v2/hojin/updateInfo/workplace',
        ]);
    });

    test('a missing token is refused up front', () => {
        assert.throws(() => createGbizClient({}), /apiToken is required/);
    });
});

describe('response envelope handling', () => {
    test('the known envelope shapes are accepted', () => {
        const record = { corporate_number: PARENT };
        assert.equal(extractRecords({ 'hojin-infos': [record] }).length, 1);
        assert.equal(extractRecords({ hojinInfos: [record] }).length, 1);
        assert.equal(extractRecords({ results: [record] }).length, 1);
        assert.equal(extractRecords([record]).length, 1);
        assert.deepEqual(extractRecords({}), []);
    });

    // "No records" and "we could not read the response" must not look the same:
    // silently returning [] would show up as a company with no subsidies.
    test('an unrecognized shape throws instead of reading as empty', () => {
        assert.throws(() => extractRecords({ unexpected: { nested: true } }), /unrecognized/);
    });

    test('the untouched payload is kept alongside the mapped fields', () => {
        const raw = { corporate_number: PARENT, name: 'テスト', extra: 'kept' };
        const record = normalizeRecord(raw);

        assert.equal(record.corporateNumber, PARENT);
        assert.equal(record.raw.extra, 'kept');
    });
});

describe('differential sync', () => {
    // Polling every company across nine categories would be hundreds of thousands
    // of requests a day. The update feed plus an intersection is the whole point.
    test('detail is fetched only for tracked companies that changed', async () => {
        const { gbiz, calls } = client([
            {
                body: {
                    'hojin-infos': [
                        { corporate_number: PARENT },
                        { corporate_number: RESEARCH_SUBSIDIARY },
                        { corporate_number: '9999999999999' },
                    ],
                },
            },
            { body: { 'hojin-infos': [{ corporate_number: PARENT, amount: '1000' }] } },
        ]);

        const results = [];
        for await (const entry of gbiz.syncCategory('subsidy', {
            from: '2026-08-01',
            to: '2026-08-14',
            targetNumbers: [PARENT, SALES_SUBSIDIARY],
        })) {
            results.push(entry);
        }

        assert.deepEqual(
            results.map((entry) => entry.corporateNumber),
            [PARENT],
            'only the intersection is fetched'
        );
        // One feed call plus one detail call -- not one per target.
        assert.equal(calls.length, 2);
    });

    test('a company appearing twice in the feed is fetched once', async () => {
        const { gbiz, calls } = client([
            {
                body: {
                    'hojin-infos': [{ corporate_number: PARENT }, { corporate_number: PARENT }],
                },
            },
            { body: { 'hojin-infos': [] } },
        ]);

        const seen = [];
        for await (const entry of gbiz.syncCategory('patent', {
            from: '2026-08-01',
            to: '2026-08-14',
            targetNumbers: new Set([PARENT]),
        })) {
            seen.push(entry.corporateNumber);
        }

        assert.deepEqual(seen, [PARENT]);
        assert.equal(calls.length, 2);
    });

    test('nothing relevant changing costs one request', async () => {
        const { gbiz, calls } = client([
            { body: { 'hojin-infos': [{ corporate_number: '9999999999999' }] } },
        ]);

        const seen = [];
        for await (const entry of gbiz.syncCategory('finance', {
            from: '2026-08-01',
            to: '2026-08-14',
            targetNumbers: [PARENT],
        })) {
            seen.push(entry);
        }

        assert.deepEqual(seen, []);
        assert.equal(calls.length, 1);
    });
});

describe('stored facts', () => {
    test('a record becomes a fact with its fetch time and api version', () => {
        const fact = toGbizFact(
            PARENT,
            'subsidy',
            normalizeRecord({
                corporate_number: PARENT,
                date_of_approval: '2024-03-15',
                amount: '12,000,000',
                title: '研究開発補助金',
                government_departments: '経済産業省',
            }),
            { fetchedAt: '2026-08-14T00:00:00Z' }
        );

        assert.equal(fact.amount, 12_000_000);
        assert.equal(fact.eventDate, '2024-03-15');
        assert.equal(fact.category, 'subsidy');
        // Administrative records are revised in place, so without this the data
        // has no provenance in time at all.
        assert.equal(fact.fetchedAt, '2026-08-14T00:00:00Z');
        assert.equal(fact.apiVersion, 'v2');
    });

    test('the basic category is stored under a name, not an empty string', () => {
        const fact = toGbizFact(PARENT, '', normalizeRecord({ corporate_number: PARENT }), {
            fetchedAt: '2026-08-14T00:00:00Z',
        });
        assert.equal(fact.category, 'basic');
    });
});

describe('group scope and aggregation', () => {
    let db;

    beforeEach(() => {
        db = openDatabase(':memory:');
        upsertCompany(db, {
            edinetCode: 'E99999',
            secCode: '99990',
            corporateNumber: PARENT,
            name: '親会社',
        });
        recordGroupMembers(db, 'E99999', [
            { corporateNumber: RESEARCH_SUBSIDIARY, name: '中央研究所', validFrom: '2020-04-01' },
            {
                corporateNumber: SALES_SUBSIDIARY,
                name: '販売会社',
                validFrom: '2020-04-01',
                validUntil: '2024-04-01',
            },
        ]);
    });

    test('the scope includes the parent and its members', () => {
        assert.deepEqual(
            getGroupCorporateNumbers(db, 'E99999'),
            [PARENT, RESEARCH_SUBSIDIARY, SALES_SUBSIDIARY].sort()
        );
    });

    // Group membership changes year to year, so the scope is period-scoped.
    test('a member that has left is out of scope after its window', () => {
        const before = getGroupCorporateNumbers(db, 'E99999', { asOf: '2023-01-01' });
        const after = getGroupCorporateNumbers(db, 'E99999', { asOf: '2025-01-01' });

        assert.ok(before.includes(SALES_SUBSIDIARY));
        assert.ok(!after.includes(SALES_SUBSIDIARY));
        assert.ok(after.includes(RESEARCH_SUBSIDIARY));
    });

    // The same corporate number reachable twice must not be counted twice: every
    // total downstream sums over this list.
    test('a number reachable by two relations appears once', () => {
        recordGroupMembers(db, 'E99999', [
            { corporateNumber: RESEARCH_SUBSIDIARY, relation: 'equity_method' },
        ]);

        const scope = getGroupCorporateNumbers(db, 'E99999', {
            relations: ['consolidated', 'equity_method'],
        });

        assert.equal(scope.filter((number) => number === RESEARCH_SUBSIDIARY).length, 1);
    });

    test('a number that is both parent and member appears once', () => {
        recordGroupMembers(db, 'E99999', [{ corporateNumber: PARENT }]);
        const scope = getGroupCorporateNumbers(db, 'E99999');

        assert.equal(scope.filter((number) => number === PARENT).length, 1);
    });

    // The trap: filings are under the parent, grants are under the subsidiary.
    test('a subsidiary-held subsidy counts toward the group', () => {
        recordGbizFacts(db, [
            toGbizFact(
                RESEARCH_SUBSIDIARY,
                'subsidy',
                normalizeRecord({ date_of_approval: '2024-03-15', amount: '80000000', title: 'A' }),
                { fetchedAt: '2026-08-14T00:00:00Z' }
            ),
            toGbizFact(
                PARENT,
                'subsidy',
                normalizeRecord({ date_of_approval: '2024-03-20', amount: '20000000', title: 'B' }),
                { fetchedAt: '2026-08-14T00:00:00Z' }
            ),
        ]);

        const group = aggregateGbizByGroup(db, 'E99999', 'subsidy');
        assert.equal(group.records, 2);
        assert.equal(group.total, 100_000_000);
    });

    test('re-syncing the same record updates rather than duplicating', () => {
        const fact = toGbizFact(
            PARENT,
            'subsidy',
            normalizeRecord({ date_of_approval: '2024-03-20', amount: '20000000', title: 'B' }),
            { fetchedAt: '2026-08-14T00:00:00Z' }
        );

        recordGbizFacts(db, [fact]);
        recordGbizFacts(db, [{ ...fact, amount: 25_000_000, fetchedAt: '2026-08-15T00:00:00Z' }]);

        const group = aggregateGbizByGroup(db, 'E99999', 'subsidy');
        assert.equal(group.records, 1, 'the same record must not accumulate rows');
        assert.equal(group.total, 25_000_000);
    });

    // Counting an award the reader could not yet have known about is the same
    // look-ahead leak the financial side is built to avoid.
    test('events after the as_of are excluded', () => {
        recordGbizFacts(db, [
            toGbizFact(
                PARENT,
                'subsidy',
                normalizeRecord({ date_of_approval: '2024-03-20', amount: '20000000', title: 'B' }),
                { fetchedAt: '2026-08-14T00:00:00Z' }
            ),
            toGbizFact(
                PARENT,
                'subsidy',
                normalizeRecord({ date_of_approval: '2025-06-01', amount: '50000000', title: 'C' }),
                { fetchedAt: '2026-08-14T00:00:00Z' }
            ),
        ]);

        assert.equal(
            aggregateGbizByGroup(db, 'E99999', 'subsidy', { asOf: '2024-12-31' }).total,
            20_000_000
        );
        assert.equal(aggregateGbizByGroup(db, 'E99999', 'subsidy').total, 70_000_000);
    });

    test('a group with no records reports no total rather than zero', () => {
        const group = aggregateGbizByGroup(db, 'E99999', 'patent');
        assert.equal(group.records, 0);
        assert.equal(group.total, null);
    });
});

describe('public procurement exposure', () => {
    let db;

    beforeEach(() => {
        db = openDatabase(':memory:');
        upsertCompany(db, {
            edinetCode: 'E99999',
            corporateNumber: PARENT,
            name: '親会社',
        });
        recordGroupMembers(db, 'E99999', [{ corporateNumber: SALES_SUBSIDIARY, name: '販売会社' }]);
        recordGbizFacts(db, [
            toGbizFact(
                SALES_SUBSIDIARY,
                'procurement',
                normalizeRecord({
                    date_of_award: '2024-02-01',
                    amount: '4500000000',
                    title: '入札',
                }),
                { fetchedAt: '2026-08-14T00:00:00Z' }
            ),
        ]);
    });

    // EDINET segment disclosures do not separate public-sector revenue, so this
    // ratio is not obtainable from filings alone.
    test('awarded value is expressed against revenue', () => {
        const exposure = estimateProcurementExposure(db, 'E99999', {
            netSales: 45_000_000_000,
        });

        assert.equal(exposure.total, 4_500_000_000);
        assert.equal(exposure.ratio, 0.1);
    });

    test('without revenue the ratio is null rather than misleading', () => {
        const exposure = estimateProcurementExposure(db, 'E99999', {});
        assert.equal(exposure.ratio, null);
        assert.equal(exposure.total, 4_500_000_000);
    });
});
