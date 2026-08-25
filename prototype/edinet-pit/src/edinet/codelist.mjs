/**
 * EDINET code list (EdinetcodeDlInfo.csv).
 *
 * This file is the join key between EDINET and every corporate-number-keyed
 * dataset, gBizINFO included: it carries both the securities code and the filer's
 * 13-digit corporate number. Because that mapping is published here, nothing in
 * this pipeline ever has to match companies by name -- which is fortunate, since
 * name matching breaks on 株式会社 placement, holdings abbreviations and renames.
 *
 * Deliberately free of node:sqlite so it runs on any supported Node version:
 * the coverage script in docs/research/scripts imports from here rather than
 * carrying a second copy of this logic.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export const CODELIST_URL =
    'https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip';

/**
 * Reads the distributed code list, accepting either the zip or the CSV inside it.
 *
 * The file is CP932. Read as UTF-8 it does not fail -- the column names come out
 * mangled, the header lookup misses, and the whole list silently yields nothing.
 */
export function readCodeListFile(path) {
    const bytes = path.endsWith('.zip')
        ? execFileSync('unzip', ['-p', path, '*EdinetcodeDlInfo.csv'], {
              maxBuffer: 256 * 1024 * 1024,
              encoding: 'buffer',
          })
        : readFileSync(path);

    return new TextDecoder('shift_jis').decode(bytes);
}

/** Downloads the current code list and returns its decoded text. */
export function fetchCodeList({ tmpPath = '/tmp/Edinetcode.zip' } = {}) {
    const zip = execFileSync('curl', ['-sSL', '--max-time', '120', CODELIST_URL], {
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'buffer',
    });
    writeFileSync(tmpPath, zip);
    return readCodeListFile(tmpPath);
}

/** RFC 4180-ish parser. Addresses in this file contain commas and quotes. */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];

        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                field += ch;
            }
            continue;
        }

        if (ch === '"') {
            quoted = true;
        } else if (ch === ',') {
            row.push(field);
            field = '';
        } else if (ch === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else if (ch !== '\r') {
            field += ch;
        }
    }

    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

/**
 * Validates a corporate number's check digit, per the National Tax Agency spec.
 *
 *   corporate number = check digit (1) + base number (12)
 *   check digit = 9 - (sum of P_n * Q_n) mod 9
 *   P_n = nth digit of the base number from the right
 *   Q_n = 1 when n is odd, 2 when n is even
 *
 * A length check alone passes typos that this catches.
 */
export function isValidCorporateNumber(value) {
    if (!/^\d{13}$/.test(value)) {
        return false;
    }
    const check = Number(value[0]);
    const base = value.slice(1);
    let sum = 0;
    for (let n = 1; n <= 12; n += 1) {
        sum += Number(base[12 - n]) * (n % 2 === 1 ? 1 : 2);
    }
    return check === 9 - (sum % 9);
}

const COLUMNS = {
    edinetCode: 'EDINETコード',
    submitterType: '提出者種別',
    listed: '上場区分',
    consolidated: '連結の有無',
    capital: '資本金',
    fiscalYearEnd: '決算日',
    name: '提出者名',
    nameEnglish: '提出者名（英字）',
    industry: '提出者業種',
    secCode: '証券コード',
    corporateNumber: '提出者法人番号',
};

export class CodeListFormatError extends Error {
    constructor(message, detail) {
        super(message);
        this.name = 'CodeListFormatError';
        this.detail = detail;
    }
}

/**
 * Parses the decoded CSV into records.
 *
 * The distributed file opens with a metadata line before the real header, so the
 * header is located by content rather than by position -- a fixed row index would
 * break the day that preamble changes. A missing expected column throws instead
 * of yielding records full of undefined.
 */
export function parseCodeList(text) {
    const raw = parseCsv(text);
    const headerIndex = raw.findIndex((row) =>
        row.some((cell) => cell.trim() === COLUMNS.edinetCode)
    );

    if (headerIndex === -1) {
        throw new CodeListFormatError(
            'header row not found; check the CP932 decoding and the file type'
        );
    }

    const header = raw[headerIndex].map((cell) => cell.trim());
    const indices = {};
    const missing = [];

    for (const [key, label] of Object.entries(COLUMNS)) {
        const index = header.indexOf(label);
        // Only the join keys are required; the rest are nice to have.
        if (index === -1) {
            if (['edinetCode', 'secCode', 'corporateNumber'].includes(key)) {
                missing.push(label);
            }
            continue;
        }
        indices[key] = index;
    }

    if (missing.length > 0) {
        throw new CodeListFormatError(`missing expected columns: ${missing.join(', ')}`, {
            header,
        });
    }

    const cell = (row, key) => (indices[key] === undefined ? '' : (row[indices[key]] ?? '').trim());

    return raw
        .slice(headerIndex + 1)
        .filter((row) => cell(row, 'edinetCode') !== '')
        .map((row) => {
            const record = {};
            for (const key of Object.keys(indices)) {
                record[key] = cell(row, key);
            }
            // Kept as text throughout: leading zeros in a corporate number are
            // significant, and a numeric round trip drops them.
            record.isListed = record.secCode !== '';
            return record;
        });
}

/**
 * Coverage of the corporate number column.
 *
 * Split by submitter type on purpose. Individual and foreign filers have no
 * corporate number at all, so a single blended rate understates how joinable the
 * data actually is and would push you toward name matching for no reason.
 */
export function summarizeCorporateNumbers(records) {
    const withNumber = records.filter((record) => record.corporateNumber !== '');
    const byNumber = new Map();

    for (const record of withNumber) {
        const list = byNumber.get(record.corporateNumber) ?? [];
        list.push(record);
        byNumber.set(record.corporateNumber, list);
    }

    const byType = new Map();
    for (const record of records) {
        const key = record.submitterType || '(unknown)';
        const bucket = byType.get(key) ?? { total: 0, withNumber: 0 };
        bucket.total += 1;
        if (record.corporateNumber !== '') {
            bucket.withNumber += 1;
        }
        byType.set(key, bucket);
    }

    const listed = records.filter((record) => record.isListed);

    return {
        total: records.length,
        listed: listed.length,
        withNumber: withNumber.length,
        listedWithNumber: listed.filter((record) => record.corporateNumber !== '').length,
        malformed: withNumber.filter((record) => !/^\d{13}$/.test(record.corporateNumber)),
        badCheckDigit: withNumber.filter(
            (record) =>
                /^\d{13}$/.test(record.corporateNumber) &&
                !isValidCorporateNumber(record.corporateNumber)
        ),
        // One corporate number against several EDINET codes makes the join
        // one-to-many. Joining without knowing that multiplies rows.
        duplicates: [...byNumber.entries()].filter(([, list]) => list.length > 1),
        byType: [...byType.entries()].sort((a, b) => b[1].total - a[1].total),
    };
}
