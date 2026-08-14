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
// パーサと検査用数字はプロトタイプ側のモジュールが正。ここで再実装しない。
import {
    parseCodeList,
    summarizeCorporateNumbers,
} from '../../../prototype/edinet-pit/src/edinet/codelist.mjs';

const CODELIST_URL =
    'https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip';
const GBIZ_BASE = 'https://api.info.gbiz.go.jp/hojin/v2/hojin';

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

function printTypeTable(byType) {
    console.log('\n## 提出者種別ごと（個人・外国法人は法人番号を持たないのが正常）');
    console.log('| 区分 | 件数 | 法人番号あり | 充足率 |');
    console.log('|---|---:|---:|---:|');
    for (const [type, bucket] of byType) {
        console.log(
            `| ${type} | ${bucket.total} | ${bucket.withNumber} |` +
                ` ${pct(bucket.withNumber, bucket.total)} |`
        );
    }
}

async function sampleGbiz(records, sampleSize) {
    const token = process.env.GBIZ_API_TOKEN;
    if (!token) {
        console.log('\n[skip] GBIZ_API_TOKEN が未設定のため gBizINFO 照会は行いません。');
        return;
    }

    // 上場かつ法人番号ありの母集団から等間隔に抽出（先頭偏りを避ける）
    const pool = records.filter((r) => r.corporateNumber !== '' && r.isListed);
    const step = Math.max(1, Math.floor(pool.length / sampleSize));
    const sample = [];
    for (let i = 0; i < pool.length && sample.length < sampleSize; i += step) {
        sample.push(pool[i]);
    }

    console.log(`\n## gBizINFO 実照会（${sample.length}件 / 母集団 ${pool.length}件）`);
    let found = 0;
    let missing = 0;
    const failures = [];

    for (const record of sample) {
        try {
            const res = await fetch(`${GBIZ_BASE}/${record.corporateNumber}`, {
                headers: { 'X-hojinInfo-api-token': token },
            });
            if (res.ok) {
                found += 1;
            } else if (res.status === 404) {
                missing += 1;
                failures.push(`${record.corporateNumber} ${record.name} → 404`);
            } else {
                failures.push(`${record.corporateNumber} ${record.name} → HTTP ${res.status}`);
            }
        } catch (err) {
            failures.push(`${record.corporateNumber} ${record.name} → ${err.message}`);
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

    const records = parseCodeList(loadCsvText(inputPath, shouldFetch));
    const summary = summarizeCorporateNumbers(records);

    console.log('# EDINETコード一覧 法人番号 充足率レポート');
    console.log(`\n- 総提出者数: ${summary.total}`);
    console.log(`- 証券コードあり（上場相当）: ${summary.listed}`);
    console.log(
        `- 法人番号あり: ${summary.withNumber} (${pct(summary.withNumber, summary.total)})` +
            ` / 上場相当のみ: ${summary.listedWithNumber}` +
            ` (${pct(summary.listedWithNumber, summary.listed)})`
    );
    console.log(`- 13桁でない値: ${summary.malformed.length}`);
    console.log(`- 検査用数字が不正: ${summary.badCheckDigit.length}`);
    console.log(`- 同一法人番号に複数EDINETコード: ${summary.duplicates.length}組`);

    printTypeTable(summary.byType);

    if (summary.duplicates.length > 0) {
        console.log('\n## 同一法人番号の重複（結合時に1:Nになる箇所）');
        for (const [number, list] of summary.duplicates.slice(0, 20)) {
            const detail = list
                .map((r) => `${r.edinetCode}${r.secCode ? `/${r.secCode}` : ''} ${r.name}`)
                .join(' , ');
            console.log(`- ${number}: ${detail}`);
        }
        if (summary.duplicates.length > 20) {
            console.log(`- ...ほか ${summary.duplicates.length - 20}組`);
        }
    }

    if (summary.badCheckDigit.length > 0) {
        console.log('\n## 検査用数字が不正な値（要目視）');
        for (const record of summary.badCheckDigit.slice(0, 20)) {
            console.log(`- ${record.corporateNumber} ${record.edinetCode} ${record.name}`);
        }
    }

    if (outArg) {
        const outPath = outArg.slice('--out='.length);
        const lines = ['edinet_code,sec_code,corporate_number,listed,submitter_type,name'];
        for (const record of records) {
            lines.push(
                [
                    record.edinetCode,
                    record.secCode ?? '',
                    record.corporateNumber ?? '',
                    record.listed ?? '',
                    record.submitterType ?? '',
                    `"${(record.name ?? '').replaceAll('"', '""')}"`,
                ].join(',')
            );
        }
        writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
        console.log(`\nマッピングを書き出しました: ${outPath} (${records.length}行)`);
    }

    if (sampleArg) {
        await sampleGbiz(
            records,
            Number.parseInt(sampleArg.slice('--gbiz-sample='.length), 10) || 20
        );
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
