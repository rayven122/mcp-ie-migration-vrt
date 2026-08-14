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

import { DOC_TYPE, eachDate, isFinancialFiling } from './edinet/client.mjs';
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
    const { docType = DOC_TYPE.CSV, rawStore } = options;

    if (document.submittedAt === null) {
        // known_from comes from this. Without it the fact has no position on the
        // knowledge timeline, and guessing one would corrupt every as_of read.
        return { docId: document.docId, skippedReason: 'missing submitted time', facts: 0 };
    }
    if (document.fiscalYear === null) {
        return { docId: document.docId, skippedReason: 'missing period end', facts: 0 };
    }

    const bytes = await client.fetchDocument(document.docId, docType);

    // Stored before anything is parsed, so a document survives even if the
    // normalizer throws on it. Fixing the normalizer later must not require
    // going back to EDINET for bytes we already had.
    const rawObjectKey = rawStore ? rawStore.put(bytes) : null;

    const result = applyDocument(db, { ...document, rawObjectKey }, bytes, options);
    return { ...result, rawObjectKey };
}

/**
 * Normalizes already-fetched bytes and records them. Shared by ingestion and by
 * re-normalization, so both paths cannot drift apart in how they interpret a
 * document.
 */
function applyDocument(db, document, bytes, options = {}) {
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
 * Re-derives facts for stored documents straight from the lake.
 *
 * This is the reason the lake exists. After a mapping or context-rule change, all
 * history has to be reprocessed; doing that over the network would mean thousands
 * of requests against a public service for bytes already on disk. Deliberately
 * takes no client, so it cannot make a request even by accident.
 */
export function renormalize(db, rawStore, options = {}) {
    const conditions = ['raw_object_key IS NOT NULL'];
    const params = [];

    if (options.from) {
        conditions.push('submitted_at >= ?');
        params.push(options.from);
    }
    if (options.to) {
        conditions.push('submitted_at <= ?');
        params.push(options.to);
    }
    if (options.docIds?.length) {
        conditions.push(`doc_id IN (${options.docIds.map(() => '?').join(', ')})`);
        params.push(...options.docIds);
    }

    const documents = db.all(
        `SELECT doc_id, edinet_code, doc_type_code, period_start, period_end,
                fiscal_year, submitted_at, is_amendment, amends_doc_id, raw_object_key
         FROM documents
         WHERE ${conditions.join(' AND ')}
         ORDER BY submitted_at`,
        ...params
    );

    const results = [];
    for (const row of documents) {
        const document = {
            docId: row.doc_id,
            edinetCode: row.edinet_code,
            docTypeCode: row.doc_type_code,
            periodStart: row.period_start,
            periodEnd: row.period_end,
            fiscalYear: row.fiscal_year,
            submittedAt: row.submitted_at,
            isAmendment: row.is_amendment === 1,
            amendsDocId: row.amends_doc_id,
            rawObjectKey: row.raw_object_key,
        };

        try {
            results.push(applyDocument(db, document, rawStore.get(row.raw_object_key), options));
        } catch (error) {
            results.push({ docId: row.doc_id, error: error.message, facts: 0 });
        }
    }

    return results;
}

/** Dates already ingested, so a resumed run can skip them. */
export function completedDates(db) {
    return new Set(
        db.all("SELECT date FROM ingest_progress WHERE status = 'completed'").map((row) => row.date)
    );
}

function recordProgress(db, date, results) {
    const facts = results.reduce((total, result) => total + (result.facts ?? 0), 0);
    const failed = results.filter((result) => result.error).length;

    db.run(
        `INSERT INTO ingest_progress (date, status, documents, facts, failed, completed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (date) DO UPDATE SET
            status = excluded.status,
            documents = excluded.documents,
            facts = excluded.facts,
            failed = excluded.failed,
            completed_at = excluded.completed_at`,
        date,
        // A day with failures is not finished: resuming should try it again rather
        // than treating a partial result as the whole day.
        failed === 0 ? 'completed' : 'partial',
        results.length,
        facts,
        failed,
        new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    );
}

/**
 * Walks a date range and ingests the periodic financial filings it finds.
 *
 * Each finished day is recorded, and days already completed are skipped on a
 * later run: a ten-year backfill will be interrupted, and starting over would
 * mean re-downloading everything already held. A day that had failures is marked
 * partial rather than completed, so a retry picks it up again.
 *
 * A generator so the caller can persist as it goes and stop early, and so one
 * unreadable document does not discard a day: failures are reported per document
 * and the walk continues.
 */
export async function* ingestRange(db, client, options) {
    const {
        from,
        to,
        filter = isFinancialFiling,
        docType = DOC_TYPE.CSV,
        rawStore,
        force = false,
    } = options;

    const alreadyDone = force ? new Set() : completedDates(db);

    for (const date of eachDate(from, to)) {
        if (alreadyDone.has(date)) {
            yield { date, skipped: true, results: [] };
            continue;
        }

        const documents = (await client.listDocuments(date)).filter(filter);
        const results = [];

        for (const document of documents) {
            try {
                results.push(await ingestDocument(db, client, document, { docType, rawStore }));
            } catch (error) {
                results.push({
                    docId: document.docId,
                    error: error.message,
                    facts: 0,
                });
            }
        }

        recordProgress(db, date, results);
        yield { date, skipped: false, results };
    }
}

/** Rolls per-document results into totals worth watching over a backfill. */
export function summarizeIngest(days) {
    const summary = {
        days: days.length,
        skippedDays: days.filter((day) => day.skipped).length,
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
