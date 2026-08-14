#!/usr/bin/env node
/**
 * EDINETコード一覧（EdinetcodeDlInfo.csv）の法人番号充足率を実測する。
 *
 * EDINET ↔ gBizINFO を法人番号(13桁)で結合できるかは、この列がどれだけ埋まっているかに
 * 依存する。名称マッチングに退避せずに済むかを、着手前に確定させるための計測。
 *
 * 使い方:
 *   node edinet-corporate-number-coverage.mjs --fetch
 *   node edinet-corporate-number-coverage.mjs path/to/Edinetcode.zip
 *   node edinet-corporate-number-coverage.mjs path/to/EdinetcodeDlInfo.csv
 *
 * オプション:
 *   --out=mapping.csv       結合用マッピング（edinet_code,sec_code,corporate_number,...）を書き出す
 *   --gbiz-sample=N         法人番号N件をgBizINFOに実照会し、登録実在率を測る
 *                           要 GBIZ_API_TOKEN。利用申請で取得した自分のトークンを使うこと
 *                           （Swagger掲載の動作確認用トークンは当該ページ限定のため使用しない）
 *
 * 出力はすべて標準出力。ネットワークとファイル書き込み以外の副作用はない。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODELIST_URL =
    'https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip';
const GBIZ_BASE = 'https://api.info.gbiz.go.jp/hojin/v2/hojin';

/** RFC4180 相当のCSVパーサ。所在地に読点や引用符が入るため自前で処理する。 */
function parseCsv(text) {
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
 * 法人番号の検査用数字を検証する（国税庁の仕様）。
 * 法人番号 = 検査用数字1桁 + 基礎番号12桁
 * 検査用数字 = 9 - (Σ P_n × Q_n) mod 9   P_n: 基礎番号の下位n桁目, Q_n: nが奇数→1, 偶数→2
 */
function isValidCorporateNumber(value) {
    if (!/^\d{13}$/.test(value)) {
        return false;
    }
    const check = Number(value[0]);
    const base = value.slice(1);
    let sum = 0;
    for (let n = 1; n <= 12; n += 1) {
        const digit = Number(base[12 - n]);
        sum += digit * (n % 2 === 1 ? 1 : 2);
    }
    return check === 9 - (sum % 9);
}

function fetchCodeListZip() {
    process.stderr.write(`fetching ${CODELIST_URL}\n`);
    return execFileSync('curl', ['-sSL', '--max-time', '120', CODELIST_URL], {
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'buffer',
    });
}

/** zip/csv/未指定を受け取り、CP932としてデコードした本文を返す。 */
function loadCsvText(inputPath, shouldFetch) {
    let bytes;
    if (shouldFetch) {
        const tmp = '/tmp/Edinetcode.zip';
        writeFileSync(tmp, fetchCodeListZip());
        bytes = execFileSync('unzip', ['-p', tmp, '*EdinetcodeDlInfo.csv'], {
            maxBuffer: 256 * 1024 * 1024,
            encoding: 'buffer',
        });
    } else if (inputPath.endsWith('.zip')) {
        bytes = execFileSync('unzip', ['-p', inputPath, '*EdinetcodeDlInfo.csv'], {
            maxBuffer: 256 * 1024 * 1024,
            encoding: 'buffer',
        });
    } else {
        bytes = readFileSync(inputPath);
    }
    // EDINETの配布CSVはCP932。UTF-8として読むと列名が壊れて突合できない。
    return new TextDecoder('shift_jis').decode(bytes);
}

function pct(numerator, denominator) {
    if (denominator === 0) {
        return '  n/a';
    }
    return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function tally(rows, keyFn) {
    const buckets = new Map();
    for (const row of rows) {
        const key = keyFn(row) || '(空)';
        const bucket = buckets.get(key) || { total: 0, withNumber: 0 };
        bucket.total += 1;
        if (row.corporateNumber !== '') {
            bucket.withNumber += 1;
        }
        buckets.set(key, bucket);
    }
    return [...buckets.entries()].sort((a, b) => b[1].total - a[1].total);
}

function printTable(title, entries) {
    console.log(`\n## ${title}`);
    console.log('| 区分 | 件数 | 法人番号あり | 充足率 |');
    console.log('|---|---:|---:|---:|');
    for (const [key, bucket] of entries) {
        console.log(
            `| ${key} | ${bucket.total} | ${bucket.withNumber} | ${pct(bucket.withNumber, bucket.total)} |`
        );
    }
}

async function sampleGbiz(rows, sampleSize) {
    const token = process.env.GBIZ_API_TOKEN;
    if (!token) {
        console.log('\n[skip] GBIZ_API_TOKEN が未設定のため gBizINFO 照会は行いません。');
        return;
    }

    // 上場かつ法人番号ありの母集団から等間隔に抽出（先頭偏りを避ける）
    const pool = rows.filter((r) => r.corporateNumber !== '' && r.secCode !== '');
    const step = Math.max(1, Math.floor(pool.length / sampleSize));
    const sample = [];
    for (let i = 0; i < pool.length && sample.length < sampleSize; i += step) {
        sample.push(pool[i]);
    }

    console.log(`\n## gBizINFO 実照会（${sample.length}件 / 母集団 ${pool.length}件）`);
    let found = 0;
    let missing = 0;
    const failures = [];

    for (const row of sample) {
        const url = `${GBIZ_BASE}/${row.corporateNumber}`;
        try {
            const res = await fetch(url, { headers: { 'X-hojinInfo-api-token': token } });
            if (res.ok) {
                found += 1;
            } else if (res.status === 404) {
                missing += 1;
                failures.push(`${row.corporateNumber} ${row.name} → 404`);
            } else {
                failures.push(`${row.corporateNumber} ${row.name} → HTTP ${res.status}`);
            }
        } catch (err) {
            failures.push(`${row.corporateNumber} ${row.name} → ${err.message}`);
        }
        // 公的APIに対する礼儀。リクエスト上限があるため詰めて叩かない。
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    console.log(`- 取得成功: ${found} / ${sample.length} (${pct(found, sample.length)})`);
    console.log(`- gBizINFO未登録(404): ${missing}`);
    if (failures.length > 0) {
        console.log('- 失敗の内訳:');
        for (const line of failures.slice(0, 20)) {
            console.log(`  - ${line}`);
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const shouldFetch = args.includes('--fetch');
    const outArg = args.find((a) => a.startsWith('--out='));
    const sampleArg = args.find((a) => a.startsWith('--gbiz-sample='));
    const inputPath = args.find((a) => !a.startsWith('--'));

    if (!shouldFetch && !inputPath) {
        console.error('usage: node edinet-corporate-number-coverage.mjs [--fetch | <zip|csv>]');
        process.exit(2);
    }

    const text = loadCsvText(inputPath, shouldFetch);
    const raw = parseCsv(text);

    // 1行目はダウンロード日時等のメタ行。'EDINETコード' を含む行を見出しとして採用する。
    const headerIndex = raw.findIndex((r) => r.some((c) => c.trim() === 'EDINETコード'));
    if (headerIndex === -1) {
        console.error('見出し行が見つかりません。CP932デコードとファイル種別を確認してください。');
        process.exit(1);
    }
    const header = raw[headerIndex].map((c) => c.trim());
    const col = (name) => header.indexOf(name);

    const idx = {
        edinetCode: col('EDINETコード'),
        submitterType: col('提出者種別'),
        listed: col('上場区分'),
        name: col('提出者名'),
        industry: col('提出者業種'),
        secCode: col('証券コード'),
        corporateNumber: col('提出者法人番号'),
    };

    const missingCols = Object.entries(idx)
        .filter(([, v]) => v === -1)
        .map(([k]) => k);
    if (missingCols.length > 0) {
        console.error(`想定列が見つかりません: ${missingCols.join(', ')}`);
        console.error(`実際の見出し: ${header.join(' | ')}`);
        process.exit(1);
    }

    const rows = raw
        .slice(headerIndex + 1)
        .filter((r) => (r[idx.edinetCode] || '').trim() !== '')
        .map((r) => ({
            edinetCode: (r[idx.edinetCode] || '').trim(),
            submitterType: (r[idx.submitterType] || '').trim(),
            listed: (r[idx.listed] || '').trim(),
            name: (r[idx.name] || '').trim(),
            industry: (r[idx.industry] || '').trim(),
            secCode: (r[idx.secCode] || '').trim(),
            corporateNumber: (r[idx.corporateNumber] || '').trim(),
        }));

    const withNumber = rows.filter((r) => r.corporateNumber !== '');
    const malformed = withNumber.filter((r) => !/^\d{13}$/.test(r.corporateNumber));
    const badCheckDigit = withNumber.filter(
        (r) => /^\d{13}$/.test(r.corporateNumber) && !isValidCorporateNumber(r.corporateNumber)
    );

    const byNumber = new Map();
    for (const row of withNumber) {
        const list = byNumber.get(row.corporateNumber) || [];
        list.push(row);
        byNumber.set(row.corporateNumber, list);
    }
    const duplicates = [...byNumber.entries()].filter(([, list]) => list.length > 1);

    const listedRows = rows.filter((r) => r.secCode !== '');

    console.log('# EDINETコード一覧 法人番号 充足率レポート');
    console.log(`\n- 総提出者数: ${rows.length}`);
    console.log(`- 証券コードあり（上場相当）: ${listedRows.length}`);
    console.log(
        `- 法人番号あり: ${withNumber.length} (${pct(withNumber.length, rows.length)})` +
            ` / 上場相当のみ: ${listedRows.filter((r) => r.corporateNumber !== '').length}` +
            ` (${pct(
                listedRows.filter((r) => r.corporateNumber !== '').length,
                listedRows.length
            )})`
    );
    console.log(`- 13桁でない値: ${malformed.length}`);
    console.log(`- 検査用数字が不正: ${badCheckDigit.length}`);
    console.log(`- 同一法人番号に複数EDINETコード: ${duplicates.length}組`);

    printTable(
        '提出者種別ごと（個人・外国法人は法人番号を持たないのが正常）',
        tally(rows, (r) => r.submitterType)
    );
    printTable(
        '上場区分ごと',
        tally(rows, (r) => r.listed)
    );

    if (duplicates.length > 0) {
        console.log('\n## 同一法人番号の重複（結合時に1:Nになる箇所）');
        for (const [number, list] of duplicates.slice(0, 20)) {
            const detail = list
                .map((r) => `${r.edinetCode}${r.secCode ? `/${r.secCode}` : ''} ${r.name}`)
                .join(' , ');
            console.log(`- ${number}: ${detail}`);
        }
        if (duplicates.length > 20) {
            console.log(`- ...ほか ${duplicates.length - 20}組`);
        }
    }

    if (badCheckDigit.length > 0) {
        console.log('\n## 検査用数字が不正な値（要目視）');
        for (const row of badCheckDigit.slice(0, 20)) {
            console.log(`- ${row.corporateNumber} ${row.edinetCode} ${row.name}`);
        }
    }

    if (outArg) {
        const outPath = outArg.slice('--out='.length);
        const lines = ['edinet_code,sec_code,corporate_number,listed,submitter_type,name'];
        for (const row of rows) {
            const name = `"${row.name.replaceAll('"', '""')}"`;
            lines.push(
                [
                    row.edinetCode,
                    row.secCode,
                    row.corporateNumber,
                    row.listed,
                    row.submitterType,
                    name,
                ].join(',')
            );
        }
        writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
        console.log(`\nマッピングを書き出しました: ${outPath} (${rows.length}行)`);
    }

    if (sampleArg) {
        await sampleGbiz(rows, Number.parseInt(sampleArg.slice('--gbiz-sample='.length), 10) || 20);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
