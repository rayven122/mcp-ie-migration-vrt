#!/usr/bin/env node
/**
 * MCP server over the point-in-time store.
 *
 * Deliberately few tools, each taking lists. An agent comparing ten companies
 * across five metrics and five years should spend one call, not 250: every tool
 * definition costs context on the client side, and every call costs a request
 * against whatever rate limit applies. A wide surface of single-value getters is
 * the expensive shape on both counts.
 *
 * Responses state unit, consolidation, accounting basis and as_of explicitly.
 * A language model reading bare numbers will otherwise compare figures in
 * different units or mix consolidated with parent-only and produce a confident
 * ratio that means nothing -- preventing that is the server's job, not the
 * caller's.
 *
 * Database selection:
 *   EDINET_PIT_DB=/path/to.db   use that store
 *   unset                       in-memory store seeded from the fixtures
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { KNOWN_FIELDS } from '../normalize/index.mjs';
import { loadFixtures } from '../query/demo.mjs';
import { getFinancials, getRestatements, toDelimited } from '../query/financials.mjs';
import { openDatabase } from '../store/db.mjs';
import { getFactHistory } from '../store/facts.mjs';

const db = openDatabase(process.env.EDINET_PIT_DB ?? ':memory:');

if (!process.env.EDINET_PIT_DB) {
    // stdio transport: anything on stdout would corrupt the JSON-RPC stream.
    console.error('[edinet-pit] no EDINET_PIT_DB set, seeding an in-memory store from fixtures');
    loadFixtures(db);
}

const server = new McpServer(
    { name: 'edinet-pit', version: '0.1.0' },
    {
        instructions: [
            'Point-in-time financial data from Japanese securities reports.',
            'Pass as_of to read figures as they were knowable at that instant;',
            'omit it for the latest figures. A row with later_restated=1 was',
            'corrected after the as_of you asked for.',
            'All monetary values are in JPY. Batch your requests: every tool',
            'accepts lists of companies, fields and years.',
        ].join(' '),
    }
);

const ISO_INSTANT = z
    .string()
    .regex(
        /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?Z?)?$/,
        'expected an ISO-8601 date or instant'
    )
    .describe('point in time to read as of, e.g. 2024-08-01 or 2024-08-01T00:00:00Z');

/** Bare dates mean the start of that day, so a filing later that day is not yet knowable. */
function toInstant(value) {
    if (value === undefined) {
        return undefined;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return `${value}T00:00:00Z`;
    }
    return value.replace(' ', 'T').replace(/Z?$/, 'Z');
}

function textResult(text) {
    return { content: [{ type: 'text', text }] };
}

function errorResult(error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
}

server.registerTool(
    'list_fields',
    {
        description:
            'Canonical field names accepted by get_financials, and the companies present in this store.',
        inputSchema: {},
    },
    async () => {
        try {
            const companies = db.all(
                'SELECT DISTINCT company_id, COUNT(*) AS facts FROM facts GROUP BY company_id ORDER BY company_id'
            );
            return textResult(
                [
                    `fields: ${KNOWN_FIELDS.join(', ')}`,
                    `companies: ${companies.map((row) => `${row.company_id}(${row.facts})`).join(', ') || 'none'}`,
                    'units: monetary fields are JPY; number_of_employees is PERSONS',
                ].join('\n')
            );
        } catch (error) {
            return errorResult(error);
        }
    }
);

server.registerTool(
    'get_financials',
    {
        description:
            'Financial figures for several companies, fields and years at once. ' +
            'Pass as_of to get the values knowable at that time rather than the latest.',
        inputSchema: {
            company_ids: z.array(z.string()).min(1).describe('EDINET codes, e.g. E02144'),
            fields: z.array(z.string()).optional().describe('canonical field names; omit for all'),
            fiscal_years: z
                .array(z.number().int())
                .optional()
                .describe('fiscal years, named for the year the period started'),
            as_of: ISO_INSTANT.optional(),
            consolidated: z
                .boolean()
                .optional()
                .describe('true for consolidated (default), false for parent-only'),
            include_guesses: z
                .boolean()
                .optional()
                .describe('include figures whose element name was inferred rather than mapped'),
        },
    },
    async (args) => {
        try {
            const result = getFinancials(db, {
                companyIds: args.company_ids,
                fields: args.fields,
                fiscalYears: args.fiscal_years,
                asOf: toInstant(args.as_of),
                consolidated: args.consolidated ?? true,
                includeGuesses: args.include_guesses ?? true,
            });

            if (result.rows.length === 0) {
                return textResult(
                    'no figures for that scope' +
                        (args.as_of ? ` as of ${args.as_of} (nothing was filed yet?)` : '')
                );
            }
            return textResult(toDelimited(result));
        } catch (error) {
            return errorResult(error);
        }
    }
);

server.registerTool(
    'get_restatements',
    {
        description:
            'Figures that were later corrected, with when it happened and what changed. ' +
            'Use this to check whether a period you are analysing is stable.',
        inputSchema: {
            company_ids: z.array(z.string()).min(1).describe('EDINET codes'),
            fields: z.array(z.string()).optional(),
            fiscal_years: z.array(z.number().int()).optional(),
            consolidated: z.boolean().optional(),
        },
    },
    async (args) => {
        try {
            const events = getRestatements(db, {
                companyIds: args.company_ids,
                fields: args.fields,
                fiscalYears: args.fiscal_years,
                consolidated: args.consolidated ?? true,
            });

            if (events.length === 0) {
                return textResult('no restatements in that scope');
            }

            const lines = [
                '# unit=JPY',
                'restated_at,company,fiscal_year,field,from,to,delta,from_doc,to_doc',
            ];
            for (const event of events) {
                lines.push(
                    [
                        event.restatedAt,
                        event.companyId,
                        event.fiscalYear,
                        event.fieldKey,
                        event.fromValue ?? '',
                        event.toValue ?? '',
                        event.delta ?? '',
                        event.fromDocId,
                        event.toDocId,
                    ].join(',')
                );
            }
            return textResult(lines.join('\n'));
        } catch (error) {
            return errorResult(error);
        }
    }
);

server.registerTool(
    'get_fact_history',
    {
        description:
            'Every value one figure has ever had, with the window each was knowable in ' +
            'and the document it came from. Use this to audit a single number.',
        inputSchema: {
            company_id: z.string().describe('EDINET code'),
            fiscal_year: z.number().int(),
            field: z.string().describe('canonical field name'),
            consolidated: z.boolean().optional(),
        },
    },
    async (args) => {
        try {
            const history = getFactHistory(db, {
                companyId: args.company_id,
                fiscalYear: args.fiscal_year,
                fieldKey: args.field,
                consolidated: args.consolidated ?? true,
            });

            if (history.length === 0) {
                return textResult('no such figure in this store');
            }

            const lines = [
                'known_from,known_until,value,unit,basis,source_doc,source_element,layer',
            ];
            for (const row of history) {
                lines.push(
                    [
                        row.known_from,
                        row.known_until ?? 'current',
                        row.value ?? '',
                        row.unit,
                        row.accounting_basis,
                        row.source_doc_id,
                        row.source_element_id,
                        row.mapping_layer,
                    ].join(',')
                );
            }
            return textResult(lines.join('\n'));
        } catch (error) {
            return errorResult(error);
        }
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
