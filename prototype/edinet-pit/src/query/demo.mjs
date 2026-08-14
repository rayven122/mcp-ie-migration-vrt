#!/usr/bin/env node
/**
 * Runs the claim this prototype exists to test, end to end, against the fixtures.
 *
 *   node prototype/edinet-pit/src/query/demo.mjs
 *
 * Loads three filings -- an annual report, an amendment restating it, and the
 * following year's report -- then reads the same figure at two points in time and
 * prints the restatement events. If the two reads differ, the store is answering
 * "what was knowable then" rather than "what do we know now".
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFiling } from '../normalize/index.mjs';
import { openDatabase } from '../store/db.mjs';
import { recordDocument, recordFacts } from '../store/facts.mjs';
import { getFinancials, getRestatements, toDelimited } from './financials.mjs';

const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'fixtures',
    'edinet',
    'filings.json'
);

/** Loads the fixture filings into a fresh store, normalizing on the way in. */
export function loadFixtures(db, { filings } = JSON.parse(readFileSync(fixturePath, 'utf8'))) {
    const report = [];

    for (const filing of filings) {
        const { facts, skipped } = normalizeFiling(filing.rows, {
            companyId: filing.doc.edinetCode,
            fiscalYear: filing.doc.fiscalYear,
            accountingBasis: filing.accountingBasis,
        });

        recordDocument(db, filing.doc);
        recordFacts(db, filing.doc, facts);
        report.push({ docId: filing.doc.docId, facts: facts.length, skipped });
    }

    return report;
}

function main() {
    const db = openDatabase(':memory:');
    const ingested = loadFixtures(db);

    console.log('# ingested');
    for (const entry of ingested) {
        console.log(
            `  ${entry.docId}: ${entry.facts} facts` +
                ` (skipped: context=${entry.skipped.context}` +
                ` unmapped=${entry.skipped.unmapped.length})`
        );
    }

    const scope = { companyIds: ['E99999'], fields: ['net_sales'], fiscalYears: [2023] };

    for (const asOf of ['2024-08-01T00:00:00Z', '2025-01-01T00:00:00Z']) {
        const result = getFinancials(db, { ...scope, asOf });
        console.log(`\n# FY2023 net_sales as of ${asOf}`);
        console.log(toDelimited(result));
    }

    console.log('\n# current view');
    console.log(toDelimited(getFinancials(db, scope)));

    console.log('\n# restatement events');
    const events = getRestatements(db, { companyIds: ['E99999'] });
    if (events.length === 0) {
        console.log('  none');
    }
    for (const event of events) {
        const direction = event.delta > 0 ? '+' : '';
        console.log(
            `  ${event.restatedAt}  FY${event.fiscalYear} ${event.fieldKey}:` +
                ` ${event.fromValue} -> ${event.toValue}` +
                ` (${direction}${event.delta} ${event.unit})` +
                ` ${event.fromDocId} -> ${event.toDocId}`
        );
    }

    db.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
