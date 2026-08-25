import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { loadFixtures } from '../src/query/demo.mjs';
import { getFinancials, getRestatements, toDelimited } from '../src/query/financials.mjs';
import { openDatabase } from '../src/store/db.mjs';

const SCOPE = { companyIds: ['E99999'], fields: ['net_sales'], fiscalYears: [2023] };

const BEFORE_CORRECTION = '2024-08-01T00:00:00Z';
const AFTER_CORRECTION = '2025-01-01T00:00:00Z';

const ORIGINAL_SALES = 45_000_000_000;
const RESTATED_SALES = 44_100_000_000;

describe('point-in-time financial reads over the fixture filings', () => {
    let db;

    beforeEach(() => {
        db = openDatabase(':memory:');
        loadFixtures(db);
    });

    // This is the claim the prototype was built to test. If it regresses, the
    // product thesis is gone, so it is asserted directly rather than through the
    // store primitives.
    test('the same query at two times returns the figure knowable at each', () => {
        const before = getFinancials(db, { ...SCOPE, asOf: BEFORE_CORRECTION });
        const after = getFinancials(db, { ...SCOPE, asOf: AFTER_CORRECTION });

        assert.equal(before.rows[0].value, ORIGINAL_SALES);
        assert.equal(after.rows[0].value, RESTATED_SALES);
        assert.notEqual(before.rows[0].value, after.rows[0].value);
    });

    // Serving a figure that was later invalidated without saying so is the
    // failure a PIT store exists to prevent.
    test('a figure that was later corrected is flagged as such', () => {
        const before = getFinancials(db, { ...SCOPE, asOf: BEFORE_CORRECTION });

        assert.equal(before.rows[0].laterRestated, true);
        assert.equal(before.rows[0].supersededAt, '2024-11-05T00:00:00Z');
        assert.equal(before.meta.restatedCount, 1);
    });

    test('the current view carries the restated figure and no flag', () => {
        const current = getFinancials(db, SCOPE);

        assert.equal(current.meta.view, 'current');
        assert.equal(current.rows[0].value, RESTATED_SALES);
        assert.equal(current.rows[0].laterRestated, false);
        assert.equal(current.rows[0].supersededAt, null);
    });

    test('each read names the document it came from', () => {
        const before = getFinancials(db, { ...SCOPE, asOf: BEFORE_CORRECTION });
        const after = getFinancials(db, { ...SCOPE, asOf: AFTER_CORRECTION });

        assert.equal(before.rows[0].sourceDocId, 'S100ORIG');
        assert.equal(after.rows[0].sourceDocId, 'S100AMND');
        assert.equal(before.rows[0].sourceElementId, 'jppfs_cor:NetSales');
    });

    test('nothing is knowable before the first filing', () => {
        const result = getFinancials(db, { ...SCOPE, asOf: '2024-01-01T00:00:00Z' });
        assert.deepEqual(result.rows, []);
    });

    test('a batch read spans companies, fields and years in one call', () => {
        const result = getFinancials(db, {
            companyIds: ['E99999'],
            fields: ['net_sales', 'operating_income'],
            fiscalYears: [2023, 2024],
        });

        const seen = result.rows.map((row) => `${row.fiscalYear} ${row.fieldKey}`).sort();
        assert.deepEqual(seen, [
            '2023 net_sales',
            '2023 operating_income',
            '2024 net_sales',
            '2024 operating_income',
        ]);
    });

    test('parent-only figures are reachable and distinct from consolidated', () => {
        const consolidated = getFinancials(db, SCOPE);
        const parentOnly = getFinancials(db, { ...SCOPE, consolidated: false });

        assert.equal(consolidated.rows[0].value, RESTATED_SALES);
        assert.equal(parentOnly.rows[0].value, 12_000_000_000);
    });

    test('guesses can be excluded from a read', () => {
        const all = getFinancials(db, { companyIds: ['E99999'] });
        const strict = getFinancials(db, { companyIds: ['E99999'], includeGuesses: false });

        assert.ok(all.rows.length > 0);
        assert.ok(strict.rows.every((row) => row.mappingLayer === 'layer1'));
    });
});

describe('restatement events', () => {
    let db;

    beforeEach(() => {
        db = openDatabase(':memory:');
        loadFixtures(db);
    });

    test('a restatement reports when it happened and what changed', () => {
        const [event] = getRestatements(db, { ...SCOPE });

        assert.equal(event.restatedAt, '2024-11-05T00:00:00Z');
        assert.equal(event.fromValue, ORIGINAL_SALES);
        assert.equal(event.toValue, RESTATED_SALES);
        assert.equal(event.delta, RESTATED_SALES - ORIGINAL_SALES);
        assert.equal(event.fromDocId, 'S100ORIG');
        assert.equal(event.toDocId, 'S100AMND');
    });

    test('every restated field in the amendment is reported', () => {
        const events = getRestatements(db, { companyIds: ['E99999'] });

        assert.deepEqual(events.map((event) => event.fieldKey).sort(), [
            'net_sales',
            'total_assets',
        ]);
    });

    // The amendment re-reported operating_income unchanged. Reporting that as a
    // restatement would be inventing an event that never happened.
    test('a re-reported unchanged figure produces no event', () => {
        const events = getRestatements(db, {
            companyIds: ['E99999'],
            fields: ['operating_income'],
        });
        assert.deepEqual(events, []);
    });

    // The FY2024 filing restates FY2023 comparatives to the corrected figure.
    // That agrees with the amendment, so it must not read as a further change.
    test('comparatives agreeing with the correction add no event', () => {
        const events = getRestatements(db, { ...SCOPE });
        assert.equal(events.length, 1);
    });

    test('an untouched company reports nothing', () => {
        assert.deepEqual(getRestatements(db, { companyIds: ['E00000'] }), []);
    });
});

describe('delimited rendering', () => {
    test('shared attributes are declared once in the header', () => {
        const db = openDatabase(':memory:');
        loadFixtures(db);

        const text = toDelimited(getFinancials(db, { ...SCOPE, asOf: BEFORE_CORRECTION }));
        const [header, columns, ...rows] = text.split('\n');

        assert.match(header, /unit=JPY/);
        assert.match(header, /consolidated=true/);
        assert.match(header, /as_of=2024-08-01T00:00:00Z/);
        assert.equal(columns, 'company,fiscal_year,field,value,basis,later_restated,source_doc');
        assert.equal(rows.length, 1);
        assert.equal(rows[0], `E99999,2023,net_sales,${ORIGINAL_SALES},jp_gaap,1,S100ORIG`);

        // No key repeats per row: that is the point of this format.
        assert.ok(!rows[0].includes('unit'));
        db.close();
    });
});
