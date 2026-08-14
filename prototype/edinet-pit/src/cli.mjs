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
import { parseCodeList, readCodeListFile } from './edinet/codelist.mjs';
import { getUniverse, loadCompanyMaster, reconcileDelistings } from './edinet/companies.mjs';
import { ingestRange, renormalize, summarizeIngest } from './ingest.mjs';
import { getFinancials, getRestatements, toDelimited } from './query/financials.mjs';
import { openDatabase } from './store/db.mjs';
import { getFactHistory } from './store/facts.mjs';
import { createRawStore } from './store/raw.mjs';

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
            '  companies <Edinetcode.zip|EdinetcodeDlInfo.csv> [--db=path] [--observed-at=YYYY-MM-DD]',
            '  universe [--db=path] [--listed-only] [--as-of=YYYY-MM-DD]',
            '  renormalize [--from=ISO] [--to=ISO] [--db=path] [--lake=path]',
            '  report --company=EDINETCODE [--field=net_sales] [--as-of=YYYY-MM-DD] [--db=path]',
            '  demo',
            '',
            'backfill needs EDINET_API_KEY. renormalize uses only the lake, never the network.',
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
    // Keeping the originals is what makes a later normalization fix affordable:
    // without them, every rule change means re-downloading the same years again.
    const rawStore = createRawStore({ root: args.lake ?? 'edinet-pit-lake' });

    const days = [];
    for await (const day of ingestRange(db, client, {
        from: args.from,
        to: args.to,
        filter: isFinancialFiling,
        rawStore,
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
    const lake = rawStore.stats();
    console.log(`lake: ${lake.objects} objects, ${(lake.bytes / 1e6).toFixed(1)} MB`);

    // These are the mapping's next entries, ordered by how much they would buy.
    if (summary.topUnmapped.length > 0) {
        console.log('\nmost frequently unmapped elements:');
        for (const [elementId, count] of summary.topUnmapped) {
            console.log(`  ${count.toString().padStart(6)}  ${elementId}`);
        }
    }

    db.close();
}

/**
 * Loads the company master from a code list and dates any delistings.
 *
 * Run this on a schedule. EDINET publishes only the current list, so listing
 * history accumulates from the first time you look -- a company that leaves
 * between two runs can only be dated to the run that noticed.
 */
function companiesCommand(args) {
    const path = args._[1];
    if (!path) {
        usage();
        process.exit(2);
    }

    const db = openDatabase(args.db ?? 'edinet-pit.db');
    const observedAt =
        typeof args['observed-at'] === 'string'
            ? args['observed-at']
            : new Date().toISOString().slice(0, 10);

    const records = parseCodeList(readCodeListFile(path));
    const { written } = loadCompanyMaster(db, records, { observedAt });
    const { delisted, comparedTo } = reconcileDelistings(db, records, { observedAt });

    console.log(`observed_at: ${observedAt}`);
    console.log(`companies written: ${written}`);
    console.log(`listed: ${records.filter((record) => record.isListed).length}`);

    if (comparedTo === null) {
        console.log('no earlier snapshot to compare against; history starts here');
    } else {
        console.log(`compared to ${comparedTo}: ${delisted.length} newly delisted`);
        for (const entry of delisted.slice(0, 20)) {
            console.log(`  ${entry.edinetCode}  ${entry.reason}`);
        }
    }

    db.close();
}

/** The survivorship-free universe, or a point-in-time slice of it. */
function universeCommand(args) {
    const db = openDatabase(args.db ?? 'edinet-pit.db');
    const rows = getUniverse(db, {
        listedOnly: args['listed-only'] === true,
        asOf: typeof args['as-of'] === 'string' ? args['as-of'] : undefined,
    });

    console.log('edinet_code,sec_code,corporate_number,listing_status,delisted_at');
    for (const row of rows) {
        console.log(
            [
                row.edinet_code,
                row.sec_code ?? '',
                row.corporate_number ?? '',
                row.listing_status,
                row.delisted_at ?? '',
            ].join(',')
        );
    }
    console.log(`\n${rows.length} companies`);
    db.close();
}

/**
 * Re-derives facts from the lake. Takes no client at all, so a rule change can be
 * applied to all of history without a single request against a public service.
 */
function renormalizeCommand(args) {
    const db = openDatabase(args.db ?? 'edinet-pit.db');
    const rawStore = createRawStore({ root: args.lake ?? 'edinet-pit-lake' });

    const results = renormalize(db, rawStore, {
        from: typeof args.from === 'string' ? args.from : undefined,
        to: typeof args.to === 'string' ? args.to : undefined,
    });

    const failed = results.filter((result) => result.error);
    const facts = results.reduce((total, result) => total + (result.facts ?? 0), 0);

    console.log(`documents re-normalized: ${results.length - failed.length}/${results.length}`);
    console.log(`facts: ${facts}`);
    for (const result of failed.slice(0, 20)) {
        console.log(`  failed ${result.docId}: ${result.error}`);
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
    } else if (command === 'companies') {
        companiesCommand(args);
    } else if (command === 'universe') {
        universeCommand(args);
    } else if (command === 'renormalize') {
        renormalizeCommand(args);
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
