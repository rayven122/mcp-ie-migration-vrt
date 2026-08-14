import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getResponseText, McpClient } from '../../../test/mcp-client.mjs';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.mjs');

// One client for the whole file, matching the convention in the package's own
// suites: a server process per test is slow and buys nothing here.
let client;

before(async () => {
    client = new McpClient({}, 30_000, SERVER);
    await client.start();
});

after(async () => {
    // The method is stop(), not close(). Getting this wrong leaves the server
    // process alive and the test runner never exits.
    await client?.stop();
});

/** Rows of a delimited response, dropping the header comment and column line. */
function dataLines(text) {
    return text
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('#'))
        .slice(1);
}

describe('tool surface', () => {
    // Every tool definition costs client context, so the surface staying small is
    // a property worth asserting rather than a coincidence.
    test('the server exposes a small batch-oriented tool set', async () => {
        const tools = await client.listTools();
        const names = tools.map((tool) => tool.name).sort();

        assert.deepEqual(names, [
            'get_fact_history',
            'get_financials',
            'get_restatements',
            'list_fields',
        ]);
    });

    test('get_financials takes lists rather than single values', async () => {
        const tools = await client.listTools();
        const tool = tools.find((entry) => entry.name === 'get_financials');

        for (const key of ['company_ids', 'fields', 'fiscal_years']) {
            assert.equal(tool.inputSchema.properties[key].type, 'array', `${key} should be a list`);
        }
    });

    test('list_fields names the fields and companies available', async () => {
        const text = getResponseText(await client.callTool('list_fields'));

        assert.match(text, /net_sales/);
        assert.match(text, /E99999/);
        assert.match(text, /JPY/);
    });
});

describe('point-in-time reads over MCP', () => {
    // The product claim, exercised through the transport an agent actually uses.
    test('as_of returns the figure knowable then, not the latest', async () => {
        const before = getResponseText(
            await client.callTool('get_financials', {
                company_ids: ['E99999'],
                fields: ['net_sales'],
                fiscal_years: [2023],
                as_of: '2024-08-01',
            })
        );
        const after = getResponseText(
            await client.callTool('get_financials', {
                company_ids: ['E99999'],
                fields: ['net_sales'],
                fiscal_years: [2023],
                as_of: '2025-01-01',
            })
        );

        assert.match(before, /45000000000/);
        assert.match(after, /44100000000/);
    });

    // A model reading bare numbers would otherwise mix units or mix consolidated
    // with parent-only and produce a confident, meaningless ratio.
    test('the response states unit, consolidation and as_of', async () => {
        const text = getResponseText(
            await client.callTool('get_financials', {
                company_ids: ['E99999'],
                as_of: '2024-08-01',
            })
        );

        assert.match(text, /unit=JPY/);
        assert.match(text, /consolidated=true/);
        assert.match(text, /as_of=2024-08-01T00:00:00Z/);
        assert.match(text, /view=point_in_time/);
    });

    test('a figure later corrected is flagged in the row', async () => {
        const text = getResponseText(
            await client.callTool('get_financials', {
                company_ids: ['E99999'],
                fields: ['net_sales'],
                fiscal_years: [2023],
                as_of: '2024-08-01',
            })
        );

        const [row] = dataLines(text);
        assert.match(row, /,1,S100ORIG$/, 'later_restated should be 1 and cite the original doc');
    });

    test('omitting as_of returns the current view', async () => {
        const text = getResponseText(
            await client.callTool('get_financials', {
                company_ids: ['E99999'],
                fields: ['net_sales'],
                fiscal_years: [2023],
            })
        );

        assert.match(text, /view=current/);
        assert.match(text, /44100000000/);
    });

    // A bare date must mean the start of that day, or a filing later the same day
    // would leak into an as_of that precedes it.
    test('a bare date is read as the start of that day', async () => {
        const text = getResponseText(
            await client.callTool('get_financials', {
                company_ids: ['E99999'],
                fields: ['net_sales'],
                fiscal_years: [2023],
                as_of: '2024-11-05',
            })
        );

        // The correction is filed at 00:00Z on the 5th, so it is already visible.
        assert.match(text, /44100000000/);
    });

    test('one call spans several companies, fields and years', async () => {
        const text = getResponseText(
            await client.callTool('get_financials', {
                company_ids: ['E99999'],
                fields: ['net_sales', 'operating_income'],
                fiscal_years: [2023, 2024],
            })
        );

        assert.equal(dataLines(text).length, 4);
    });

    test('parent-only figures are reachable', async () => {
        const text = getResponseText(
            await client.callTool('get_financials', {
                company_ids: ['E99999'],
                fields: ['net_sales'],
                fiscal_years: [2023],
                consolidated: false,
            })
        );

        assert.match(text, /consolidated=false/);
        assert.match(text, /12000000000/);
    });

    test('an empty scope says so instead of returning an empty table', async () => {
        const text = getResponseText(
            await client.callTool('get_financials', {
                company_ids: ['E00000'],
            })
        );

        assert.match(text, /no figures/);
    });

    test('a date before any filing reports nothing was knowable', async () => {
        const text = getResponseText(
            await client.callTool('get_financials', {
                company_ids: ['E99999'],
                as_of: '2020-01-01',
            })
        );

        assert.match(text, /no figures/);
    });

    test('a malformed as_of is rejected rather than silently ignored', async () => {
        // Schema violations surface as an RPC error; a handler failure would come
        // back as isError. Either is a rejection, neither is silent acceptance.
        let rejected = false;
        try {
            const response = await client.callTool('get_financials', {
                company_ids: ['E99999'],
                as_of: 'last summer',
            });
            rejected = response.isError === true;
        } catch {
            rejected = true;
        }
        assert.equal(rejected, true);
    });
});

describe('restatements and audit trail over MCP', () => {
    test('restatements report when and what changed', async () => {
        const text = getResponseText(
            await client.callTool('get_restatements', { company_ids: ['E99999'] })
        );

        assert.match(text, /2024-11-05T00:00:00Z/);
        assert.match(text, /net_sales/);
        assert.match(text, /S100ORIG,S100AMND/);
    });

    test('a clean scope reports no restatements', async () => {
        const text = getResponseText(
            await client.callTool('get_restatements', {
                company_ids: ['E99999'],
                fields: ['operating_income'],
            })
        );

        assert.match(text, /no restatements/);
    });

    test('fact history exposes every value with its window and source', async () => {
        const text = getResponseText(
            await client.callTool('get_fact_history', {
                company_id: 'E99999',
                fiscal_year: 2023,
                field: 'net_sales',
            })
        );

        const rows = dataLines(text);
        assert.equal(rows.length, 2);
        assert.match(rows[0], /45000000000/);
        assert.match(rows[0], /jppfs_cor:NetSales/);
        assert.match(rows[1], /current/);
    });

    test('an unknown figure is reported plainly', async () => {
        const text = getResponseText(
            await client.callTool('get_fact_history', {
                company_id: 'E99999',
                fiscal_year: 1999,
                field: 'net_sales',
            })
        );

        assert.match(text, /no such figure/);
    });
});
