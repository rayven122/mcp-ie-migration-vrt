import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { openDatabase } from '../src/store/db.mjs';
import { getFactHistory, getFactsAsOf, recordDocument, recordFacts } from '../src/store/facts.mjs';

const ORIGINAL = {
    docId: 'S100AAAA',
    edinetCode: 'E02144',
    docTypeCode: '120',
    fiscalYear: 2023,
    periodStart: '2023-04-01',
    periodEnd: '2024-03-31',
    submittedAt: '2024-06-20T00:00:00Z',
    isAmendment: false,
};

const AMENDMENT = {
    docId: 'S100BBBB',
    edinetCode: 'E02144',
    docTypeCode: '130',
    fiscalYear: 2023,
    periodStart: '2023-04-01',
    periodEnd: '2024-03-31',
    submittedAt: '2024-11-05T00:00:00Z',
    isAmendment: true,
    amendsDocId: 'S100AAAA',
};

function fact(fieldKey, value, overrides = {}) {
    return {
        companyId: 'E02144',
        fiscalYear: 2023,
        periodType: 'annual',
        consolidated: true,
        fieldKey,
        value,
        unit: 'JPY_MILLION',
        accountingBasis: 'jp_gaap',
        sourceElementId: `jppfs_cor:${fieldKey}`,
        ...overrides,
    };
}

function valueAt(db, asOf, fieldKey = 'net_sales') {
    const [row] = getFactsAsOf(db, {
        companyIds: ['E02144'],
        fields: [fieldKey],
        fiscalYears: [2023],
        asOf,
    });
    return row?.value;
}

describe('point-in-time fact store', () => {
    let db;

    beforeEach(() => {
        db = openDatabase(':memory:');
    });

    test('a correction appends a row and closes the previous one', () => {
        recordDocument(db, ORIGINAL);
        recordFacts(db, ORIGINAL, [fact('net_sales', 45000)]);
        recordDocument(db, AMENDMENT);
        recordFacts(db, AMENDMENT, [fact('net_sales', 44100)]);

        const history = getFactHistory(db, {
            companyId: 'E02144',
            fiscalYear: 2023,
            fieldKey: 'net_sales',
        });

        assert.equal(history.length, 2, 'the original must survive the correction');
        assert.equal(history[0].value, 45000);
        assert.equal(history[0].known_from, ORIGINAL.submittedAt);
        assert.equal(history[0].known_until, AMENDMENT.submittedAt);
        assert.equal(history[1].value, 44100);
        assert.equal(history[1].known_from, AMENDMENT.submittedAt);
        assert.equal(history[1].known_until, null, 'the newest row stays open');
    });

    // The thesis of the whole prototype.
    test('as_of returns the value knowable then, not the value known now', () => {
        recordDocument(db, ORIGINAL);
        recordFacts(db, ORIGINAL, [fact('net_sales', 45000)]);
        recordDocument(db, AMENDMENT);
        recordFacts(db, AMENDMENT, [fact('net_sales', 44100)]);

        assert.equal(valueAt(db, '2024-08-01T00:00:00Z'), 45000, 'before the correction');
        assert.equal(valueAt(db, '2025-01-01T00:00:00Z'), 44100, 'after the correction');
        assert.equal(valueAt(db, undefined), 44100, 'no as_of means the current view');
    });

    test('nothing is knowable before the first filing', () => {
        recordDocument(db, ORIGINAL);
        recordFacts(db, ORIGINAL, [fact('net_sales', 45000)]);

        assert.equal(valueAt(db, '2024-01-01T00:00:00Z'), undefined);
    });

    test('the correction instant already shows the corrected value', () => {
        recordDocument(db, ORIGINAL);
        recordFacts(db, ORIGINAL, [fact('net_sales', 45000)]);
        recordDocument(db, AMENDMENT);
        recordFacts(db, AMENDMENT, [fact('net_sales', 44100)]);

        assert.equal(valueAt(db, AMENDMENT.submittedAt), 44100);
    });

    // Backfill does not arrive in filing order, so placing rows must not depend
    // on the order documents happen to be processed in.
    test('ingesting out of filing order produces the same timeline', () => {
        recordDocument(db, AMENDMENT);
        recordFacts(db, AMENDMENT, [fact('net_sales', 44100)]);
        recordDocument(db, ORIGINAL);
        recordFacts(db, ORIGINAL, [fact('net_sales', 45000)]);

        assert.equal(valueAt(db, '2024-08-01T00:00:00Z'), 45000);
        assert.equal(valueAt(db, '2025-01-01T00:00:00Z'), 44100);

        const history = getFactHistory(db, {
            companyId: 'E02144',
            fiscalYear: 2023,
            fieldKey: 'net_sales',
        });
        assert.deepEqual(
            history.map((row) => [row.known_from, row.known_until, row.value]),
            [
                [ORIGINAL.submittedAt, AMENDMENT.submittedAt, 45000],
                [AMENDMENT.submittedAt, null, 44100],
            ]
        );
    });

    test('re-ingesting a document changes nothing', () => {
        recordDocument(db, ORIGINAL);
        recordFacts(db, ORIGINAL, [fact('net_sales', 45000)]);
        recordDocument(db, AMENDMENT);
        recordFacts(db, AMENDMENT, [fact('net_sales', 44100)]);

        const before = getFactHistory(db, {
            companyId: 'E02144',
            fiscalYear: 2023,
            fieldKey: 'net_sales',
        });

        recordDocument(db, ORIGINAL);
        recordFacts(db, ORIGINAL, [fact('net_sales', 45000)]);
        recordFacts(db, AMENDMENT, [fact('net_sales', 44100)]);

        assert.deepEqual(
            getFactHistory(db, {
                companyId: 'E02144',
                fiscalYear: 2023,
                fieldKey: 'net_sales',
            }),
            before
        );
    });

    // A correction restates a few figures and re-reports the rest untouched.
    // Those untouched repeats must not look like restatement events.
    test('a re-reported unchanged value does not create a restatement', () => {
        recordDocument(db, ORIGINAL);
        recordFacts(db, ORIGINAL, [fact('net_sales', 45000), fact('operating_income', 5300)]);
        recordDocument(db, AMENDMENT);
        recordFacts(db, AMENDMENT, [fact('net_sales', 44100), fact('operating_income', 5300)]);

        const restated = getFactHistory(db, {
            companyId: 'E02144',
            fiscalYear: 2023,
            fieldKey: 'net_sales',
        });
        const untouched = getFactHistory(db, {
            companyId: 'E02144',
            fiscalYear: 2023,
            fieldKey: 'operating_income',
        });

        assert.equal(restated.length, 2);
        assert.equal(untouched.length, 1, 'unchanged figures keep a single row');
        assert.equal(untouched[0].known_from, ORIGINAL.submittedAt, 'first knowable moment kept');
        assert.equal(untouched[0].known_until, null);
    });

    test('a value restated back to its earlier figure keeps all three rows', () => {
        const second = { ...AMENDMENT, docId: 'S100CCCC', submittedAt: '2025-02-01T00:00:00Z' };

        recordDocument(db, ORIGINAL);
        recordFacts(db, ORIGINAL, [fact('net_sales', 45000)]);
        recordDocument(db, AMENDMENT);
        recordFacts(db, AMENDMENT, [fact('net_sales', 44100)]);
        recordDocument(db, second);
        recordFacts(db, second, [fact('net_sales', 45000)]);

        const history = getFactHistory(db, {
            companyId: 'E02144',
            fiscalYear: 2023,
            fieldKey: 'net_sales',
        });

        assert.deepEqual(
            history.map((row) => row.value),
            [45000, 44100, 45000],
            'only consecutive duplicates collapse, not a genuine round trip'
        );
        assert.equal(valueAt(db, '2024-12-01T00:00:00Z'), 44100);
        assert.equal(valueAt(db, '2025-03-01T00:00:00Z'), 45000);
    });

    test('an accounting basis change is kept even when the figure matches', () => {
        recordDocument(db, ORIGINAL);
        recordFacts(db, ORIGINAL, [fact('net_sales', 45000)]);
        recordDocument(db, AMENDMENT);
        recordFacts(db, AMENDMENT, [
            fact('net_sales', 45000, {
                accountingBasis: 'ifrs',
                sourceElementId: 'jpigp_cor:RevenueIFRS',
            }),
        ]);

        const history = getFactHistory(db, {
            companyId: 'E02144',
            fiscalYear: 2023,
            fieldKey: 'net_sales',
        });
        assert.deepEqual(
            history.map((row) => row.accounting_basis),
            ['jp_gaap', 'ifrs']
        );
    });

    test('every fact carries the document and element it came from', () => {
        recordDocument(db, ORIGINAL);
        recordFacts(db, ORIGINAL, [fact('net_sales', 45000)]);

        const [row] = getFactsAsOf(db, { companyIds: ['E02144'], fiscalYears: [2023] });
        assert.equal(row.source_doc_id, 'S100AAAA');
        assert.equal(row.source_element_id, 'jppfs_cor:net_sales');
    });

    test('consolidated and parent-only figures are separate timelines', () => {
        recordDocument(db, ORIGINAL);
        recordFacts(db, ORIGINAL, [
            fact('net_sales', 45000),
            fact('net_sales', 12000, { consolidated: false }),
        ]);

        assert.equal(valueAt(db, undefined), 45000);
        const [parentOnly] = getFactsAsOf(db, {
            companyIds: ['E02144'],
            fields: ['net_sales'],
            consolidated: false,
        });
        assert.equal(parentOnly.value, 12000);
    });

    test('a failed document leaves no partial timeline', () => {
        recordDocument(db, ORIGINAL);
        assert.throws(() =>
            recordFacts(db, ORIGINAL, [
                fact('net_sales', 45000),
                fact('operating_income', 5300, { unit: null }),
            ])
        );

        assert.deepEqual(getFactsAsOf(db, { companyIds: ['E02144'] }), []);
    });
});
