import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';
import {
    CodeListFormatError,
    isValidCorporateNumber,
    parseCodeList,
    summarizeCorporateNumbers,
} from '../src/edinet/codelist.mjs';
import { DocumentCsvError, decodeDocumentBytes, parseDocumentCsv } from '../src/edinet/csv.mjs';
import { normalizeFiling } from '../src/normalize/index.mjs';

/** Encodes text as UTF-16LE with a BOM, which is how EDINET ships type=5. */
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

/** Encodes text as CP932, which is how the code list is distributed. */
function cp932(text) {
    return execFileSync('iconv', ['-f', 'UTF-8', '-t', 'CP932'], {
        input: Buffer.from(text, 'utf8'),
        maxBuffer: 8 * 1024 * 1024,
    });
}

const DOCUMENT_CSV = [
    [
        '要素ID',
        '項目名',
        'コンテキストID',
        '相対年度',
        '連結・個別',
        '期間・時点',
        'ユニットID',
        '単位',
        '値',
    ],
    [
        'jppfs_cor:NetSales',
        '売上高',
        'CurrentYearDuration',
        '当期',
        '連結',
        '期間',
        'JPY',
        '百万円',
        '45000',
    ],
    [
        'jppfs_cor:NetSales',
        '売上高',
        'CurrentYearDuration_NonConsolidatedMember',
        '当期',
        '個別',
        '期間',
        'JPY',
        '百万円',
        '12000',
    ],
    [
        'jppfs_cor:OperatingIncome',
        '営業利益',
        'CurrentYearDuration',
        '当期',
        '連結',
        '期間',
        'JPY',
        '百万円',
        '5300',
    ],
]
    .map((row) => row.join('\t'))
    .join('\r\n');

describe('document CSV decoding', () => {
    test('UTF-16LE with a BOM is decoded', () => {
        const text = decodeDocumentBytes(utf16le(DOCUMENT_CSV));
        assert.match(text, /要素ID/);
    });

    test('a UTF-8 BOM is stripped rather than kept as a character', () => {
        const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('要素ID')]);
        assert.equal(decodeDocumentBytes(bytes), '要素ID');
    });

    test('UTF-16LE without a BOM is still recognized', () => {
        const withBom = utf16le('要素ID');
        assert.equal(decodeDocumentBytes(withBom.subarray(2)), '要素ID');
    });

    // Reading UTF-16 as UTF-8 does not throw; it mangles the header, the lookup
    // misses, and the document contributes nothing at all.
    test('decoding with the wrong encoding is reported, not silently empty', () => {
        const mojibake = new TextDecoder('utf-8').decode(utf16le(DOCUMENT_CSV));
        assert.throws(() => parseDocumentCsv(mojibake), DocumentCsvError);
    });
});

describe('document CSV parsing', () => {
    const rows = parseDocumentCsv(decodeDocumentBytes(utf16le(DOCUMENT_CSV)));

    test('every data row is returned with its columns named', () => {
        assert.equal(rows.length, 3);
        assert.deepEqual(rows[0], {
            elementId: 'jppfs_cor:NetSales',
            itemName: '売上高',
            contextId: 'CurrentYearDuration',
            relativeYear: '当期',
            consolidatedLabel: '連結',
            periodLabel: '期間',
            unitId: 'JPY',
            unitLabel: '百万円',
            value: '45000',
        });
    });

    // The whole point of the reader: its output is what normalizeFiling consumes,
    // so the seam between them is exercised rather than assumed.
    test('parsed rows feed the normalizer directly', () => {
        const { facts } = normalizeFiling(rows, {
            companyId: 'E99999',
            fiscalYear: 2023,
            accountingBasis: 'jp_gaap',
        });

        const consolidated = facts.find((f) => f.fieldKey === 'net_sales' && f.consolidated);
        const parentOnly = facts.find((f) => f.fieldKey === 'net_sales' && !f.consolidated);

        assert.equal(consolidated.value, 45_000_000_000);
        assert.equal(parentOnly.value, 12_000_000_000);
    });

    test('a quoted field containing the delimiter stays one field', () => {
        const text = [
            '要素ID\t項目名\t相対年度\t連結・個別\t単位\t値',
            'jppfs_cor:NetSales\t"売上高\t(注)"\t当期\t連結\t百万円\t45000',
        ].join('\n');

        const [row] = parseDocumentCsv(text);
        assert.equal(row.itemName, '売上高\t(注)');
        assert.equal(row.value, '45000');
    });

    test('a missing required column throws instead of yielding undefined rows', () => {
        const text = ['要素ID\t項目名\t相対年度', 'jppfs_cor:NetSales\t売上高\t当期'].join('\n');
        assert.throws(() => parseDocumentCsv(text), /missing required columns/);
    });

    test('an empty document is refused', () => {
        assert.throws(() => parseDocumentCsv(''), DocumentCsvError);
    });
});

describe('corporate number check digit', () => {
    // Toyota's real corporate number: an external check on the formula rather
    // than a value this code produced itself.
    test('a real corporate number validates', () => {
        assert.equal(isValidCorporateNumber('1180301018771'), true);
    });

    test('a wrong check digit is caught even though the length is right', () => {
        assert.equal(isValidCorporateNumber('9180301018771'), false);
    });

    test('malformed input is rejected', () => {
        assert.equal(isValidCorporateNumber('12345'), false);
        assert.equal(isValidCorporateNumber('118030101877X'), false);
        assert.equal(isValidCorporateNumber(''), false);
    });
});

describe('code list parsing', () => {
    const CODE_LIST = [
        '"ダウンロード実行日","2026/08/14 15:00"',
        [
            'EDINETコード',
            '提出者種別',
            '上場区分',
            '提出者名',
            '提出者業種',
            '証券コード',
            '提出者法人番号',
        ]
            .map((cell) => `"${cell}"`)
            .join(','),
        '"E02144","内国法人・組合","上場","トヨタ自動車株式会社","輸送用機器","72030","1180301018771"',
        '"E99001","個人（内国）","非上場","個人提出者","","",""',
        '"E99002","外国法人・組合","非上場","Foreign Corp","","",""',
        '"E99003","内国法人・組合","非上場","子会社,株式会社 ""別名"" 付","サービス業","","1180301018771"',
    ].join('\r\n');

    const records = parseCodeList(new TextDecoder('shift_jis').decode(cp932(CODE_LIST)));

    test('the metadata preamble is skipped and the header found by content', () => {
        assert.equal(records.length, 4);
        assert.equal(records[0].edinetCode, 'E02144');
    });

    test('the corporate number is kept as text', () => {
        assert.equal(records[0].corporateNumber, '1180301018771');
        assert.equal(typeof records[0].corporateNumber, 'string');
    });

    test('listing is derived from the presence of a securities code', () => {
        assert.equal(records[0].isListed, true);
        assert.equal(records[1].isListed, false);
    });

    test('a quoted name containing a comma and quotes survives intact', () => {
        assert.equal(records[3].name, '子会社,株式会社 "別名" 付');
    });

    test('a file without the expected columns throws', () => {
        assert.throws(() => parseCodeList('"a","b"\n"1","2"'), CodeListFormatError);
    });
});

describe('corporate number coverage summary', () => {
    const records = [
        {
            edinetCode: 'E1',
            submitterType: '内国法人・組合',
            secCode: '1',
            corporateNumber: '1180301018771',
            isListed: true,
        },
        {
            edinetCode: 'E2',
            submitterType: '内国法人・組合',
            secCode: '',
            corporateNumber: '1180301018771',
            isListed: false,
        },
        {
            edinetCode: 'E3',
            submitterType: '個人（内国）',
            secCode: '',
            corporateNumber: '',
            isListed: false,
        },
        {
            edinetCode: 'E4',
            submitterType: '内国法人・組合',
            secCode: '',
            corporateNumber: '12345',
            isListed: false,
        },
        {
            edinetCode: 'E5',
            submitterType: '内国法人・組合',
            secCode: '',
            corporateNumber: '9180301018771',
            isListed: false,
        },
    ];

    const summary = summarizeCorporateNumbers(records);

    // Individual and foreign filers have no corporate number by definition, so a
    // single blended rate understates joinability and would argue for name
    // matching that is not actually needed.
    test('coverage is broken out by submitter type', () => {
        const domestic = summary.byType.find(([type]) => type === '内国法人・組合')[1];
        const individual = summary.byType.find(([type]) => type === '個人（内国）')[1];

        assert.deepEqual(domestic, { total: 4, withNumber: 4 });
        assert.deepEqual(individual, { total: 1, withNumber: 0 });
    });

    test('listed filers are counted separately', () => {
        assert.equal(summary.listed, 1);
        assert.equal(summary.listedWithNumber, 1);
    });

    test('malformed and bad-check-digit numbers are separated', () => {
        assert.deepEqual(
            summary.malformed.map((r) => r.edinetCode),
            ['E4']
        );
        assert.deepEqual(
            summary.badCheckDigit.map((r) => r.edinetCode),
            ['E5']
        );
    });

    // One corporate number against several EDINET codes makes the join
    // one-to-many; joining blind multiplies rows.
    test('one-to-many corporate numbers are surfaced', () => {
        assert.equal(summary.duplicates.length, 1);
        const [number, list] = summary.duplicates[0];
        assert.equal(number, '1180301018771');
        assert.deepEqual(
            list.map((r) => r.edinetCode),
            ['E1', 'E2']
        );
    });
});
