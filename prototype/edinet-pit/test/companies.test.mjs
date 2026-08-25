import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { getUniverse, loadCompanyMaster, reconcileDelistings } from '../src/edinet/companies.mjs';
import { openDatabase } from '../src/store/db.mjs';
import { getGroupCorporateNumbers, recordGroupMembers } from '../src/store/gbiz.mjs';

const PARENT_NUMBER = '1180301018771';
const SUBSIDIARY_NUMBER = '3010001008633';

/**
 * A code list record as parseCodeList produces it.
 *
 * isListed follows from the securities code unless a caller states otherwise,
 * mirroring how parseCodeList derives it.
 */
function record(edinetCode, overrides = {}) {
    const { secCode = '99990', isListed, ...rest } = overrides;

    return {
        edinetCode,
        submitterType: '内国法人・組合',
        name: `${edinetCode} 株式会社`,
        industry: 'サービス業',
        corporateNumber: PARENT_NUMBER,
        ...rest,
        secCode,
        isListed: isListed ?? secCode !== '',
    };
}

describe('company master', () => {
    let db;

    beforeEach(() => {
        db = openDatabase(':memory:');
    });

    test('code list records populate the master', () => {
        const { written } = loadCompanyMaster(db, [
            record('E00001'),
            record('E00002', { secCode: '', corporateNumber: SUBSIDIARY_NUMBER }),
        ]);

        assert.equal(written, 2);
        const universe = getUniverse(db);
        assert.deepEqual(
            universe.map((row) => [row.edinet_code, row.listing_status]),
            [
                ['E00001', 'listed'],
                ['E00002', 'unlisted'],
            ]
        );
    });

    // Group scope reads the parent's corporate number from this table. With an
    // empty master it silently returned only the recorded members, which reads as
    // a smaller group rather than as an error.
    test('loading the master lets group scope find the parent', () => {
        recordGroupMembers(db, 'E00001', [{ corporateNumber: SUBSIDIARY_NUMBER }]);

        assert.deepEqual(getGroupCorporateNumbers(db, 'E00001'), [SUBSIDIARY_NUMBER]);

        loadCompanyMaster(db, [record('E00001', { corporateNumber: PARENT_NUMBER })]);

        assert.deepEqual(
            getGroupCorporateNumbers(db, 'E00001'),
            [PARENT_NUMBER, SUBSIDIARY_NUMBER].sort()
        );
    });

    test('loading the same snapshot twice changes nothing', () => {
        const snapshot = [record('E00001'), record('E00002')];

        loadCompanyMaster(db, snapshot, { observedAt: '2026-08-01' });
        const first = getUniverse(db);
        loadCompanyMaster(db, snapshot, { observedAt: '2026-08-01' });

        assert.deepEqual(getUniverse(db), first);
    });

    test('a record with no EDINET code is skipped', () => {
        const { written } = loadCompanyMaster(db, [record('E00001'), { edinetCode: '' }]);
        assert.equal(written, 1);
    });
});

describe('delisting detection', () => {
    let db;

    beforeEach(() => {
        db = openDatabase(':memory:');
    });

    // Nothing to compare against on the very first look. EDINET publishes only the
    // current list, so history can only accumulate forward from here.
    test('the first snapshot cannot detect anything', () => {
        loadCompanyMaster(db, [record('E00001')], { observedAt: '2026-08-01' });

        const result = reconcileDelistings(db, [record('E00001')], { observedAt: '2026-08-01' });
        assert.deepEqual(result.delisted, []);
        assert.equal(result.comparedTo, null);
    });

    test('a company gone from the list is marked delisted', () => {
        loadCompanyMaster(db, [record('E00001'), record('E00002')], { observedAt: '2026-08-01' });

        const later = [record('E00001')];
        loadCompanyMaster(db, later, { observedAt: '2026-09-01' });
        const result = reconcileDelistings(db, later, { observedAt: '2026-09-01' });

        assert.deepEqual(result.delisted, [
            { edinetCode: 'E00002', reason: 'absent_from_code_list' },
        ]);

        const [gone] = getUniverse(db).filter((row) => row.edinet_code === 'E00002');
        assert.equal(gone.listing_status, 'delisted');
        assert.equal(gone.delisted_at, '2026-09-01');
    });

    // A management buyout looks like this: still a filer, no securities code. Easy
    // to miss precisely because the company has not disappeared.
    test('a company that only loses its securities code is caught', () => {
        loadCompanyMaster(db, [record('E00001'), record('E00002')], { observedAt: '2026-08-01' });

        const later = [record('E00001'), record('E00002', { secCode: '' })];
        loadCompanyMaster(db, later, { observedAt: '2026-09-01' });
        const result = reconcileDelistings(db, later, { observedAt: '2026-09-01' });

        assert.deepEqual(result.delisted, [
            { edinetCode: 'E00002', reason: 'securities_code_removed' },
        ]);
    });

    test('a company still listed is left alone', () => {
        loadCompanyMaster(db, [record('E00001')], { observedAt: '2026-08-01' });
        loadCompanyMaster(db, [record('E00001')], { observedAt: '2026-09-01' });

        const result = reconcileDelistings(db, [record('E00001')], { observedAt: '2026-09-01' });
        assert.deepEqual(result.delisted, []);
        assert.equal(getUniverse(db)[0].listing_status, 'listed');
    });

    // The first observation of a delisting is the one that counts; running the
    // reconciliation again must not push the date forward.
    test('the recorded date is the first observation, not the latest run', () => {
        loadCompanyMaster(db, [record('E00001'), record('E00002')], { observedAt: '2026-08-01' });
        const later = [record('E00001')];

        loadCompanyMaster(db, later, { observedAt: '2026-09-01' });
        reconcileDelistings(db, later, { observedAt: '2026-09-01' });

        loadCompanyMaster(db, later, { observedAt: '2026-10-01' });
        reconcileDelistings(db, later, { observedAt: '2026-10-01' });

        const [gone] = getUniverse(db).filter((row) => row.edinet_code === 'E00002');
        assert.equal(gone.delisted_at, '2026-09-01');
    });

    test('dating a delisting requires an observation time', () => {
        assert.throws(() => reconcileDelistings(db, [], {}), /observedAt is required/);
    });
});

describe('survivorship-free universe', () => {
    let db;

    beforeEach(() => {
        db = openDatabase(':memory:');
        loadCompanyMaster(db, [record('E00001'), record('E00002')], { observedAt: '2026-08-01' });
        const later = [record('E00001')];
        loadCompanyMaster(db, later, { observedAt: '2026-09-01' });
        reconcileDelistings(db, later, { observedAt: '2026-09-01' });
    });

    // Restricting a study to currently-listed companies is the mistake this table
    // exists to make visible: it overstates profitability by dropping the failures.
    test('delisted companies stay in the universe by default', () => {
        assert.equal(getUniverse(db).length, 2);
        assert.equal(getUniverse(db, { listedOnly: true }).length, 1);
    });

    test('asOf reconstructs who was listed at a past date', () => {
        const beforeExit = getUniverse(db, { asOf: '2026-08-15' });
        const afterExit = getUniverse(db, { asOf: '2026-10-01' });

        assert.equal(beforeExit.length, 2, 'both were still listed then');
        assert.deepEqual(
            afterExit.map((row) => row.edinet_code),
            ['E00001']
        );
    });
});
