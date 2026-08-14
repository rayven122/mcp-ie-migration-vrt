#!/usr/bin/env node
/**
 * Entry point for running the pipeline against the live EDINET API.
 *
 * Everything below has been exercised against fixtures only -- the development
 * sandbox cannot reach edinet-fsa.go.jp -- so the first real run is also the
 * first test of the assumptions about response shapes. Start with a single day
 * before committing to years.
 *
 *   EDINET_API_KEY=... node src/cli.mjs backfill --from=2024-06-20 --to=2024-06-20 --db=pit.db
 *   node src/cli.mjs report --db=pit.db --company=E02144 --field=net_sales
 *   node src/cli.mjs demo
 *
 * Be careful with the range. Ten years is a few thousand listing requests plus a
 * document download each; the client paces itself, but a backfill should still be
 * run in slices rather than as one sweep against a public service.
 */

import { createEdinetClient, isFinancialFiling } from './edinet/client.mjs';
import { ingestRange, summarizeIngest } from './ingest.mjs';
import { getFinancials, getRestatements, toDelimited } from './query/financials.mjs';
import { openDatabase } from './store/db.mjs';
import { getFactHistory } from './store/facts.mjs';

function parseArgs(argv) {
    const args = { _: [] };
    for (const token of argv) {
        const match = /^--([^=]+)(?:=(.*))?$/.exec(token);
        if (match) {
            args[match[1]] = match[2] ?? true;
        } else {
            args._.push(token);
        }
    }
    return args;
}

function usage() {
    console.error(
        [
            'usage:',
            '  backfill --from=YYYY-MM-DD --to=YYYY-MM-DD [--db=path] [--quiet]',
            '  report --company=EDINETCODE [--field=net_sales] [--as-of=YYYY-MM-DD] [--db=path]',
            '  demo',
            '',
            'backfill needs EDINET_API_KEY.',
        ].join('\n')
    );
}

async function backfill(args) {
    const apiKey = process.env.EDINET_API_KEY;
    if (!apiKey) {
        console.error('EDINET_API_KEY is not set. Obtain a key from EDINET first.');
        process.exit(2);
    }
    if (!args.from || !args.to) {
        usage();
        process.exit(2);
    }

    const db = openDatabase(args.db ?? 'edinet-pit.db');
    const client = createEdinetClient({ subscriptionKey: apiKey });

    const days = [];
    for await (const day of ingestRange(db, client, {
        from: args.from,
        to: args.to,
        filter: isFinancialFiling,
    })) {
        days.push(day);
        if (!args.quiet) {
            const facts = day.results.reduce((total, result) => total + (result.facts ?? 0), 0);
            console.error(`${day.date}  ${day.results.length} documents, ${facts} facts`);
        }
    }

    const summary = summarizeIngest(days);
    console.log(`\ndays: ${summary.days}`);
    console.log(
        `documents: ${summary.documents} (failed ${summary.failed}, skipped ${summary.skippedDocuments})`
    );
    console.log(`facts: ${summary.facts}`);
    console.log(
        `skipped rows: context ${summary.skippedRows.context}, ` +
            `unmapped ${summary.skippedRows.unmapped}, unit ${summary.skippedRows.unit}`
    );
    console.log(`requests: ${client.stats.requests} (retries ${client.stats.retries})`);

    // These are the mapping's next entries, ordered by how much they would buy.
    if (summary.topUnmapped.length > 0) {
        console.log('\nmost frequently unmapped elements:');
        for (const [elementId, count] of summary.topUnmapped) {
            console.log(`  ${count.toString().padStart(6)}  ${elementId}`);
        }
    }

    db.close();
}

function report(args) {
    if (!args.company) {
        usage();
        process.exit(2);
    }

    const db = openDatabase(args.db ?? 'edinet-pit.db');
    const asOf = typeof args['as-of'] === 'string' ? `${args['as-of']}T00:00:00Z` : undefined;
    const fields = typeof args.field === 'string' ? [args.field] : undefined;

    const result = getFinancials(db, { companyIds: [args.company], fields, asOf });
    console.log(toDelimited(result));

    const events = getRestatements(db, { companyIds: [args.company], fields });
    console.log(`\nrestatements: ${events.length}`);
    for (const event of events) {
        console.log(
            `  ${event.restatedAt}  FY${event.fiscalYear} ${event.fieldKey}: ` +
                `${event.fromValue} -> ${event.toValue}`
        );
    }

    if (fields) {
        const history = getFactHistory(db, {
            companyId: args.company,
            fiscalYear: Number(args['fiscal-year'] ?? result.rows[0]?.fiscalYear),
            fieldKey: fields[0],
        });
        if (history.length > 0) {
            console.log(`\nknowledge timeline for ${fields[0]}:`);
            for (const row of history) {
                console.log(
                    `  ${row.known_from} .. ${row.known_until ?? 'current'}  ` +
                        `${row.value}  ${row.source_doc_id}  ${row.source_element_id}`
                );
            }
        }
    }

    db.close();
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const [command] = args._;

    if (command === 'backfill') {
        await backfill(args);
    } else if (command === 'report') {
        report(args);
    } else if (command === 'demo') {
        const { runDemo } = await import('./query/demo.mjs');
        runDemo();
    } else {
        usage();
        process.exit(2);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
