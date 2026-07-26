import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fixture, getResponseText, McpClient } from './mcp-client.mjs';

const sessionIdFrom = (result) => getResponseText(result).match(/session_id: (\S+)/)?.[1];

describe('VRT', () => {
    let client;
    const sessions = [];
    const artifactRoot = path.join(process.cwd(), 'test-vrt-artifacts');

    before(async () => {
        client = new McpClient();
        await client.start();
    });

    after(async () => {
        for (const sessionId of sessions) {
            await client.callTool('close_session', { sessionId }).catch(() => {});
        }
        await client.stop();
        await fs.rm(artifactRoot, { recursive: true, force: true });
    });

    it('compares screenshots from two explicitly selected sessions', async () => {
        for (let index = 0; index < 2; index += 1) {
            const result = await client.callTool('start_browser', {
                browser: 'chrome',
                options: { headless: true, arguments: ['--no-sandbox'] },
            });
            const sessionId = sessionIdFrom(result);
            assert.ok(sessionId);
            sessions.push(sessionId);
            await client.callTool('navigate', { sessionId, url: fixture('locators.html') });
        }

        const result = await client.callTool('vrt', {
            beforeSessionId: sessions[0],
            afterSessionId: sessions[1],
            name: 'identical-pages',
            width: 800,
            height: 600,
            outputDirectory: artifactRoot,
        });
        const response = JSON.parse(getResponseText(result));
        assert.equal(response.status, 'passed', JSON.stringify(response, null, 2));
        assert.equal(response.capture.width, 800);
        assert.equal(response.capture.height, 600);
        assert.ok(response.artifacts.runDirectory.startsWith(artifactRoot));
        await fs.access(response.artifacts.before);
        await fs.access(response.artifacts.after);
        await fs.access(response.artifacts.report);
    });
});
