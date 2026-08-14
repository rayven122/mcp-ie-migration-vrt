/**
 * The full ingestion path, end to end.
 *
 * EDINET listing -> document bytes -> decode -> parse -> detect basis ->
 * normalize -> record. Each stage is tested on its own, but the seams between
 * them are where real data will break first, so this module exists to be
 * exercised as one piece against document bytes in their real encoding.
 *
 * The client is passed in rather than constructed here, which is what lets the
 * whole path run against fixtures with no network.
 */

import { DOC_TYPE, isFinancialFiling } from './edinet/client.mjs';
import { decodeDocumentBytes, parseDocumentCsv } from './edinet/csv.mjs';
import { detectAccountingBasis, normalizeFiling } from './normalize/index.mjs';
import { recordDocument, recordFacts } from './store/facts.mjs';

/** Semi-annual and quarterly filings describe a shorter period than the year. */
function periodTypeOf(docTypeCode) {
    if (docTypeCode === '160' || docTypeCode === '170') {
        return 'semi';
    }
    if (docTypeCode === '140' || docTypeCode === '150') {
        return 'quarterly';
    }
    return 'annual';
}

/**
 * Ingests one document.
 *
 * Returns what was recorded and what was skipped. A caller running a backfill
 * needs the skip counts to notice a taxonomy change: coverage falling quietly is
 * the failure mode here, not an exception.
 */
export async function ingestDocument(db, client, document, options = {}) {
    const { docType = DOC_TYPE.CSV } = options;

    if (document.submittedAt === null) {
        // known_from comes from this. Without it the fact has no position on the
        // knowledge timeline, and guessing one would corrupt every as_of read.
        return { docId: document.docId, skippedReason: 'missing submitted time', facts: 0 };
    }
    if (document.fiscalYear === null) {
        return { docId: document.docId, skippedReason: 'missing period end', facts: 0 };
    }

    const bytes = await client.fetchDocument(document.docId, docType);
    const rows = parseDocumentCsv(decodeDocumentBytes(bytes));
    const accountingBasis = options.accountingBasis ?? detectAccountingBasis(rows);

    const { facts, skipped } = normalizeFiling(rows, {
        companyId: document.edinetCode,
        fiscalYear: document.fiscalYear,
        periodType: periodTypeOf(document.docTypeCode),
        accountingBasis,
    });

    db.transaction(() => {
        recordDocument(db, document);
        recordFacts(db, document, facts);
    });

    return {
        docId: document.docId,
        accountingBasis,
        facts: facts.length,
        skipped,
    };
}

/**
 * Walks a date range and ingests the periodic financial filings it finds.
 *
 * A generator so a ten-year backfill can be interrupted and resumed, and so a
 * single unreadable document does not discard a day's work: failures are reported
 * per document and the walk continues.
 */
export async function* ingestRange(db, client, options) {
    const { from, to, filter = isFinancialFiling, docType = DOC_TYPE.CSV } = options;

    for await (const { date, documents } of client.walkDates(from, to, filter)) {
        const results = [];

        for (const document of documents) {
            try {
                results.push(await ingestDocument(db, client, document, { docType }));
            } catch (error) {
                results.push({
                    docId: document.docId,
                    error: error.message,
                    facts: 0,
                });
            }
        }

        yield { date, results };
    }
}

/** Rolls per-document results into totals worth watching over a backfill. */
export function summarizeIngest(days) {
    const summary = {
        days: days.length,
        documents: 0,
        facts: 0,
        failed: 0,
        skippedDocuments: 0,
        skippedRows: { context: 0, unmapped: 0, unit: 0 },
        unmappedElements: new Map(),
    };

    for (const day of days) {
        for (const result of day.results) {
            summary.documents += 1;
            summary.facts += result.facts ?? 0;

            if (result.error) {
                summary.failed += 1;
                continue;
            }
            if (result.skippedReason) {
                summary.skippedDocuments += 1;
                continue;
            }

            summary.skippedRows.context += result.skipped.context;
            summary.skippedRows.unmapped += result.skipped.unmapped.length;
            summary.skippedRows.unit += result.skipped.unit.length;

            for (const elementId of result.skipped.unmapped) {
                summary.unmappedElements.set(
                    elementId,
                    (summary.unmappedElements.get(elementId) ?? 0) + 1
                );
            }
        }
    }

    // The elements most often missed are the mapping's next entries.
    summary.topUnmapped = [...summary.unmappedElements.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);

    return summary;
}
