/**
 * MCP Server — connection, tool registration, and resource registration tests.
 * No browser needed for these.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpClient } from './mcp-client.mjs';

describe('MCP Server', () => {
    let client;

    before(async () => {
        client = new McpClient();
        await client.start();
    });

    after(async () => {
        await client.stop();
    });

    it('should initialize with correct server info', async () => {
        // start() already initializes, so we just verify the client is usable
        const tools = await client.listTools();
        assert.ok(tools.length > 0, 'Server should have tools registered');
    });

    it('should register all expected tools', async () => {
        const tools = await client.listTools();
        const names = tools.map((t) => t.name);

        const expected = [
            'start_browser',
            'navigate',
            'interact',
            'send_keys',
            'get_element_text',
            'press_key',
            'upload_file',
            'take_screenshot',
            'accessibility_snapshot',
            'close_session',
            'get_element_attribute',
            'execute_script',
            'window',
            'frame',
            'alert',
            'add_cookie',
            'get_cookies',
            'delete_cookie',
            'diagnostics',
            'start_vrt_browsers',
            'vrt',
        ];

        for (const name of expected) {
            assert.ok(names.includes(name), `Missing tool: ${name}`);
        }

        assert.equal(
            names.length,
            expected.length,
            `Expected ${expected.length} tools, got ${names.length}: ${names.join(', ')}`
        );
    });

    it('should include descriptions for all tools', async () => {
        const tools = await client.listTools();
        for (const tool of tools) {
            assert.ok(
                tool.description && tool.description.length > 0,
                `Tool "${tool.name}" should have a description`
            );
        }
    });

    it('should include input schemas for all tools', async () => {
        const tools = await client.listTools();
        for (const tool of tools) {
            assert.ok(tool.inputSchema, `Tool "${tool.name}" should have an inputSchema`);
            assert.equal(
                tool.inputSchema.type,
                'object',
                `Tool "${tool.name}" schema should be type object`
            );
        }
    });

    it('should omit output schemas from every tool for client compatibility', async () => {
        const tools = await client.listTools();
        for (const tool of tools) {
            assert.equal(
                tool.outputSchema,
                undefined,
                `${tool.name} should not advertise an outputSchema`
            );
        }

        const startVrtBrowsers = tools.find((tool) => tool.name === 'start_vrt_browsers');
        assert.deepEqual(
            startVrtBrowsers.inputSchema.properties.expectedBeforeDocumentMode.enum,
            [5, 7, 8, 9, 10, 11]
        );
        const vrt = tools.find((tool) => tool.name === 'vrt');
        assert.deepEqual(vrt.inputSchema.properties.returnImages.enum, ['all', 'diff', 'none']);
    });

    it('should allow selecting a session on Selenium tools', async () => {
        const tools = await client.listTools();
        const toolsWithoutSessionSelection = ['start_browser', 'start_vrt_browsers', 'vrt'];
        for (const tool of tools) {
            if (toolsWithoutSessionSelection.includes(tool.name)) continue;
            assert.ok(
                tool.inputSchema.properties.sessionId,
                `Tool "${tool.name}" should accept sessionId`
            );
        }
    });

    it('should expose edge-ie only on Windows', async () => {
        const tools = await client.listTools();
        const startBrowser = tools.find((tool) => tool.name === 'start_browser');
        assert.ok(startBrowser, 'start_browser tool should exist');

        const browserEnum = startBrowser.inputSchema.properties.browser.enum;
        if (process.platform === 'win32') {
            assert.ok(
                browserEnum.includes('edge-ie'),
                `Expected edge-ie on Windows, got: ${JSON.stringify(browserEnum)}`
            );
        } else {
            assert.ok(
                !browserEnum.includes('edge-ie'),
                `Did not expect edge-ie on ${process.platform}, got: ${JSON.stringify(browserEnum)}`
            );
        }
    });

    it('should register all expected resources', async () => {
        const resources = await client.listResources();
        const uris = resources.map((r) => r.uri);

        const expected = [
            'vrt-standard://current',
            'browser-status://current',
            'accessibility://current',
        ];

        for (const uri of expected) {
            assert.ok(uris.includes(uri), `Missing resource: ${uri}`);
        }

        assert.equal(
            uris.length,
            expected.length,
            `Expected ${expected.length} resources, got ${uris.length}: ${uris.join(', ')}`
        );
    });

    it('should expose the AI review capture standard', async () => {
        const resource = await client.readResource('vrt-standard://current');
        const standard = JSON.parse(resource.contents[0].text);
        assert.equal(standard.version, 2);
        assert.equal(standard.capture.dimensionMismatch, 'ai-review');
        assert.equal(standard.capture.returnImages, 'all');
        assert.equal(standard.capture.allowImageResize, false);
    });
});
