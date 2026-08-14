import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { selectContext } from '../src/normalize/context.mjs';
import { resolveByPattern } from '../src/normalize/fallback.mjs';
import { coverageOf, KNOWN_FIELDS, normalizeFiling } from '../src/normalize/index.mjs';
import { normalizeUnit, parseValue, UnrecognizedUnitError } from '../src/normalize/units.mjs';

/** A row as EDINET's CSV export presents it. */
function row(elementId, value, overrides = {}) {
    return {
        elementId,
        contextId: 'CurrentYearDuration',
        relativeYear: '当期',
        consolidatedLabel: '連結',
        periodLabel: '期間',
        unitLabel: '百万円',
        value,
        ...overrides,
    };
}

const FILING = { companyId: 'E02144', fiscalYear: 2023, accountingBasis: 'jp_gaap' };

function fieldsOf(result) {
    return Object.fromEntries(result.facts.map((fact) => [fact.fieldKey, fact.value]));
}

describe('unit and sign normalization', () => {
    test('monetary scales all convert to plain yen', () => {
        assert.deepEqual(normalizeUnit('100', '円'), { value: 100, unit: 'JPY' });
        assert.deepEqual(normalizeUnit('100', '千円'), { value: 100_000, unit: 'JPY' });
        assert.deepEqual(normalizeUnit('100', '百万円'), { value: 100_000_000, unit: 'JPY' });
    });

    test('non-monetary units pass through unscaled', () => {
        assert.deepEqual(normalizeUnit('370870', '人'), { value: 370870, unit: 'PERSONS' });
        assert.deepEqual(normalizeUnit('8.5', '％'), { value: 8.5, unit: 'PERCENT' });
    });

    test('negate flips loss elements to the canonical sign', () => {
        assert.deepEqual(normalizeUnit('500', '百万円', { negate: true }), {
            value: -500_000_000,
            unit: 'JPY',
        });
    });

    // "Not disclosed" and "zero" must never collapse into each other.
    test('an absent figure is null, not zero', () => {
        assert.equal(parseValue(''), null);
        assert.equal(parseValue('-'), null);
        assert.equal(parseValue('－'), null);
        assert.equal(parseValue('0'), 0);
        assert.deepEqual(normalizeUnit('', '百万円'), { value: null, unit: 'JPY' });
    });

    test('thousands separators and parenthesised negatives are read correctly', () => {
        assert.equal(parseValue('45,095,325'), 45095325);
        assert.equal(parseValue('(1,200)'), -1200);
    });

    // Guessing a scale would produce a confidently wrong figure.
    test('an unknown unit is refused rather than guessed', () => {
        assert.throws(() => normalizeUnit('100', 'ユーロ'), UnrecognizedUnitError);
    });
});

describe('context selection', () => {
    test('the current consolidated period is accepted', () => {
        assert.deepEqual(selectContext(row('x', '1')), { yearOffset: 0, consolidated: true });
    });

    test('prior periods carry their offset', () => {
        assert.deepEqual(selectContext(row('x', '1', { relativeYear: '前期' })), {
            yearOffset: -1,
            consolidated: true,
        });
        assert.deepEqual(selectContext(row('x', '1', { relativeYear: '前々期' })), {
            yearOffset: -2,
            consolidated: true,
        });
    });

    test('parent-only rows are kept and marked', () => {
        assert.deepEqual(selectContext(row('x', '1', { consolidatedLabel: '個別' })), {
            yearOffset: 0,
            consolidated: false,
        });
    });

    // Segment rows report the same element with a smaller scope. Taking one as the
    // company figure is the quiet failure this whole module exists to prevent.
    test('segment rows are rejected', () => {
        assert.equal(
            selectContext(row('x', '1', { contextId: 'CurrentYearDuration_AutoMember' })),
            null
        );
    });

    test('forecast rows are rejected', () => {
        assert.equal(
            selectContext(row('x', '1', { contextId: 'CurrentYearDuration_ForecastMember' })),
            null
        );
        assert.equal(
            selectContext(row('x', '1', { contextId: 'NextYearDuration_Forecast' })),
            null
        );
    });

    test('an unrecognized period label is rejected, not assumed current', () => {
        assert.equal(selectContext(row('x', '1', { relativeYear: '第2四半期累計' })), null);
    });

    test('includePriorYears false keeps only the current period', () => {
        assert.equal(
            selectContext(row('x', '1', { relativeYear: '前期' }), { includePriorYears: false }),
            null
        );
    });
});

describe('layer 2 pattern fallback', () => {
    test('a company extension element resolves by name shape', () => {
        assert.equal(resolveByPattern('E01234-000:NetSalesIFRS'), 'net_sales');
        assert.equal(resolveByPattern('E05678-000:OperatingProfitLoss'), 'operating_income');
    });

    test('an element it cannot place returns null', () => {
        assert.equal(resolveByPattern('E01234-000:SegmentInformationDisclosure'), null);
        assert.equal(resolveByPattern('E01234-000:主要な販売先'), null);
    });
});

describe('two-layer name resolution across accounting bases', () => {
    // The point of the mapping: the same canonical field comes out regardless of
    // which taxonomy the filer uses.
    test('JP GAAP, IFRS and a company extension all yield net_sales', () => {
        const jp = normalizeFiling([row('jppfs_cor:NetSales', '45000')], FILING);
        const ifrs = normalizeFiling([row('jpigp_cor:RevenueIFRS', '45000')], {
            ...FILING,
            accountingBasis: 'ifrs',
        });
        const extension = normalizeFiling([row('E01234-000:NetSalesIFRS', '45000')], {
            ...FILING,
            accountingBasis: 'ifrs',
        });

        assert.equal(fieldsOf(jp).net_sales, 45_000_000_000);
        assert.equal(fieldsOf(ifrs).net_sales, 45_000_000_000);
        assert.equal(fieldsOf(extension).net_sales, 45_000_000_000);
    });

    test('a layer 1 match wins over a layer 2 guess for the same field', () => {
        const result = normalizeFiling(
            [row('E01234-000:NetSalesIFRS', '99999'), row('jppfs_cor:NetSales', '45000')],
            FILING
        );

        const [fact] = result.facts.filter((f) => f.fieldKey === 'net_sales');
        assert.equal(fact.value, 45_000_000_000);
        assert.equal(fact.sourceElementId, 'jppfs_cor:NetSales');
        assert.equal(fact.mappingLayer, 'layer1');
    });

    test('within layer 1 the preferred element wins regardless of row order', () => {
        const generic = row('jppfs_cor:OperatingRevenue1', '40000');
        const preferred = row('jppfs_cor:NetSales', '45000');

        for (const rows of [
            [generic, preferred],
            [preferred, generic],
        ]) {
            const [fact] = normalizeFiling(rows, FILING).facts.filter(
                (f) => f.fieldKey === 'net_sales'
            );
            assert.equal(fact.sourceElementId, 'jppfs_cor:NetSales');
        }
    });

    test('facts resolved by pattern are labelled as guesses', () => {
        const result = normalizeFiling([row('E01234-000:NetSalesIFRS', '45000')], {
            ...FILING,
            accountingBasis: 'ifrs',
        });
        assert.equal(result.facts[0].mappingLayer, 'layer2');
    });

    test('allowFallback false reports the element as unmapped instead of guessing', () => {
        const result = normalizeFiling([row('E01234-000:NetSalesIFRS', '45000')], {
            ...FILING,
            allowFallback: false,
        });
        assert.deepEqual(result.facts, []);
        assert.deepEqual(result.skipped.unmapped, ['E01234-000:NetSalesIFRS']);
    });

    test('a loss element is stored with the canonical sign', () => {
        const result = normalizeFiling([row('jppfs_cor:OperatingLoss', '500')], FILING);
        assert.equal(fieldsOf(result).operating_income, -500_000_000);
    });

    test('prior-period rows land on their own fiscal year', () => {
        const result = normalizeFiling(
            [
                row('jppfs_cor:NetSales', '45000'),
                row('jppfs_cor:NetSales', '42000', { relativeYear: '前期' }),
                row('jppfs_cor:NetSales', '39000', { relativeYear: '前々期' }),
            ],
            FILING
        );

        assert.deepEqual(
            result.facts.map((f) => [f.fiscalYear, f.value]).sort((a, b) => a[0] - b[0]),
            [
                [2021, 39_000_000_000],
                [2022, 42_000_000_000],
                [2023, 45_000_000_000],
            ]
        );
    });

    test('consolidated and parent-only figures stay separate facts', () => {
        const result = normalizeFiling(
            [
                row('jppfs_cor:NetSales', '45000'),
                row('jppfs_cor:NetSales', '12000', { consolidatedLabel: '個別' }),
            ],
            FILING
        );

        assert.equal(result.facts.length, 2);
        const consolidated = result.facts.find((f) => f.consolidated);
        const parentOnly = result.facts.find((f) => !f.consolidated);
        assert.equal(consolidated.value, 45_000_000_000);
        assert.equal(parentOnly.value, 12_000_000_000);
    });

    test('an unusable row is reported rather than dropped silently', () => {
        const result = normalizeFiling(
            [
                row('jppfs_cor:NetSales', '45000'),
                row('jppfs_cor:NetSales', '1', { contextId: 'CurrentYearDuration_AutoMember' }),
                row('jppfs_cor:Something', '1'),
                row('jppfs_cor:Assets', '1', { unitLabel: 'ユーロ' }),
            ],
            FILING
        );

        assert.equal(result.facts.length, 1);
        assert.equal(result.skipped.context, 1);
        assert.deepEqual(result.skipped.unmapped, ['jppfs_cor:Something']);
        assert.deepEqual(result.skipped.unit, [
            { elementId: 'jppfs_cor:Assets', unitLabel: 'ユーロ' },
        ]);
    });

    test('coverage separates known mappings from guesses', () => {
        const result = normalizeFiling(
            [row('jppfs_cor:NetSales', '45000'), row('E01234-000:TotalAssets', '80000')],
            FILING
        );

        const coverage = coverageOf(result.facts, ['net_sales', 'total_assets', 'liabilities']);
        assert.equal(coverage.requested, 3);
        assert.equal(coverage.resolved, 2);
        assert.deepEqual(coverage.byLayer, { layer1: 1, layer2: 1 });
    });

    test('every mapped field key is one the store and callers can name', () => {
        assert.ok(KNOWN_FIELDS.includes('net_sales'));
        assert.ok(KNOWN_FIELDS.every((key) => /^[a-z][a-z0-9_]*$/.test(key)));
    });
});
