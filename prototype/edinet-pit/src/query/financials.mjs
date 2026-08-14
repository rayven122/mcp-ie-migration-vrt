/**
 * Read API over the point-in-time store.
 *
 * Two questions this answers that a conventional financial API cannot:
 *
 *   1. What was this figure *knowable as* at time T?
 *   2. Was the figure I am looking at later corrected?
 *
 * The second matters as much as the first. A backtest reading FY2023 revenue as
 * of mid-2024 gets the figure available then, but the researcher still wants to
 * know that it was restated in November -- silently serving a
 * later-invalidated number is exactly the failure a PIT store exists to avoid.
 */

import { getFactsAsOf } from '../store/facts.mjs';

/**
 * Batch read. Takes lists rather than single values on purpose: an agent asking
 * for ten companies across five fields and five years should cost one call, not
 * 250. That is a rate-limit and latency decision as much as an ergonomic one.
 */
export function getFinancials(db, options) {
    const {
        companyIds,
        fields,
        fiscalYears,
        asOf,
        periodType = 'annual',
        consolidated = true,
        includeGuesses = true,
    } = options;

    const rows = getFactsAsOf(db, {
        companyIds,
        fields,
        fiscalYears,
        asOf,
        periodType,
        consolidated,
    })
        .filter((row) => includeGuesses || row.mapping_layer === 'layer1')
        .map((row) => ({
            companyId: row.company_id,
            fiscalYear: row.fiscal_year,
            fieldKey: row.field_key,
            value: row.value,
            unit: row.unit,
            accountingBasis: row.accounting_basis,
            knownFrom: row.known_from,
            // Non-null means a later filing replaced this figure. At an as_of in
            // the past that is the caller's warning; in the current view it is
            // always null by construction.
            supersededAt: row.known_until,
            laterRestated: row.known_until !== null,
            sourceDocId: row.source_doc_id,
            sourceElementId: row.source_element_id,
            mappingLayer: row.mapping_layer,
        }));

    return {
        meta: {
            asOf: asOf ?? null,
            view: asOf ? 'point_in_time' : 'current',
            periodType,
            consolidated,
            // Stated once here rather than repeated per row: every value in the
            // store is already normalized to this unit.
            unit: rows.length > 0 ? rows[0].unit : null,
            restatedCount: rows.filter((row) => row.laterRestated).length,
        },
        rows,
    };
}

/**
 * Restatement events for the requested scope, oldest first.
 *
 * An event is the transition between two consecutive rows of one series: the
 * moment a figure changed, and what it changed from and to. Series with a single
 * row produce nothing, which is the common case.
 */
export function getRestatements(db, options) {
    const { companyIds, fields, fiscalYears, periodType = 'annual', consolidated = true } = options;

    const conditions = ['period_type = ?', 'consolidated = ?'];
    const params = [periodType, consolidated ? 1 : 0];

    for (const [column, values] of [
        ['company_id', companyIds],
        ['field_key', fields],
        ['fiscal_year', fiscalYears],
    ]) {
        if (values?.length) {
            conditions.push(`${column} IN (${values.map(() => '?').join(', ')})`);
            params.push(...values);
        }
    }

    const rows = db.all(
        `SELECT company_id, fiscal_year, field_key, value, unit,
                source_doc_id, known_from, known_until
         FROM facts
         WHERE ${conditions.join(' AND ')}
         ORDER BY company_id, fiscal_year, field_key, known_from`,
        ...params
    );

    const events = [];
    for (let i = 1; i < rows.length; i += 1) {
        const previous = rows[i - 1];
        const current = rows[i];
        const sameSeries =
            previous.company_id === current.company_id &&
            previous.fiscal_year === current.fiscal_year &&
            previous.field_key === current.field_key;

        if (!sameSeries) {
            continue;
        }

        events.push({
            companyId: current.company_id,
            fiscalYear: current.fiscal_year,
            fieldKey: current.field_key,
            restatedAt: current.known_from,
            fromValue: previous.value,
            toValue: current.value,
            delta:
                previous.value === null || current.value === null
                    ? null
                    : current.value - previous.value,
            unit: current.unit,
            fromDocId: previous.source_doc_id,
            toDocId: current.source_doc_id,
        });
    }

    return events;
}

/**
 * Renders rows as a dense delimited block.
 *
 * Verbose JSON is a poor way to hand a number table to a language model -- the
 * keys repeat on every row and crowd out the data. Declaring the shared
 * attributes once in a header comment and emitting bare rows costs a fraction of
 * the tokens for the same information.
 */
export function toDelimited(result) {
    const { meta, rows } = result;
    const header = [
        `# unit=${meta.unit ?? 'n/a'}`,
        `consolidated=${meta.consolidated}`,
        `period=${meta.periodType}`,
        `view=${meta.view}`,
        meta.asOf ? `as_of=${meta.asOf}` : null,
    ]
        .filter(Boolean)
        .join(' ');

    const lines = [header, 'company,fiscal_year,field,value,basis,later_restated,source_doc'];
    for (const row of rows) {
        lines.push(
            [
                row.companyId,
                row.fiscalYear,
                row.fieldKey,
                row.value ?? '',
                row.accountingBasis,
                row.laterRestated ? 1 : 0,
                row.sourceDocId,
            ].join(',')
        );
    }
    return lines.join('\n');
}
