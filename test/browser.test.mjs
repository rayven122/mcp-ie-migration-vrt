/**
 * Browser management tests — start_browser, close_session, take_screenshot,
 * multi-session handling.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fixture, getResponseText, McpClient } from './mcp-client.mjs';

describe('Browser Management', () => {
    let client;

    before(async () => {
        client = new McpClient();
        await client.start();
    });

    after(async () => {
        try {
            await client.callTool('close_session');
        } catch {
            /* ignore */
        }
        await client.stop();
    });

    describe('start_browser', () => {
        after(async () => {
            try {
                await client.callTool('close_session');
            } catch {
                /* ignore */
            }
        });

        it('should start a headless Chrome session', async () => {
            const result = await client.callTool('start_browser', {
                browser: 'chrome',
                options: { headless: true, arguments: ['--no-sandbox', '--disable-dev-shm-usage'] },
            });
            const text = getResponseText(result);
            assert.ok(text.includes('Browser started'), `Expected "Browser started", got: ${text}`);
            assert.ok(
                text.includes('session_id:'),
                `Expected session_id in response, got: ${text}`
            );
        });

        it('should reject unsafe browser arguments before launch', async () => {
            const result = await client.callTool('start_browser', {
                browser: 'chrome',
                options: {
                    headless: true,
                    arguments: ['--user-data-dir=/tmp/mcp-selenium-profile'],
                },
            });
            const text = getResponseText(result);
            assert.strictEqual(
                result.isError,
                true,
                'Expected isError: true for unsafe browser argument'
            );
            assert.ok(
                text.includes('blocked by default'),
                `Expected blocked argument message, got: ${text}`
            );
        });
    });

    describe('close_session', () => {
        it('should close an active session', async () => {
            await client.callTool('start_browser', {
                browser: 'chrome',
                options: { headless: true, arguments: ['--no-sandbox'] },
            });

            const result = await client.callTool('close_session');
            const text = getResponseText(result);
            assert.ok(text.includes('closed'), `Expected "closed" in response, got: ${text}`);
        });

        it('should error when no active session exists', async () => {
            const result = await client.callTool('close_session');
            assert.strictEqual(result.isError, true, 'Expected isError: true on error response');
            const text = getResponseText(result);
            assert.ok(
                text.includes('Error') || text.includes('No active'),
                `Expected error message, got: ${text}`
            );
        });
    });

    describe('take_screenshot', () => {
        before(async () => {
            await client.callTool('start_browser', {
                browser: 'chrome',
                options: { headless: true, arguments: ['--no-sandbox'] },
            });
            await client.callTool('navigate', { url: fixture('locators.html') });
        });

        after(async () => {
            try {
                await client.callTool('close_session');
            } catch {
                /* ignore */
            }
        });

        it('should capture a screenshot and return base64 image content', async () => {
            const result = await client.callTool('take_screenshot');
            assert.ok(result?.content?.length >= 1, 'Should return at least 1 content entry');
            const imageContent = result.content.find((c) => c.type === 'image');
            assert.ok(imageContent, 'Should contain an image content entry');
            assert.strictEqual(
                imageContent.mimeType,
                'image/png',
                'Image mimeType should be image/png'
            );
            assert.ok(
                imageContent.data.length > 100,
                `Expected base64 data, got ${imageContent.data.length} chars`
            );
        });

        it('should save screenshots only inside the working directory', async () => {
            const outputPath = path.join(process.cwd(), 'test-output-screenshot.png');
            try {
                const result = await client.callTool('take_screenshot', { outputPath });
                const text = getResponseText(result);
                assert.ok(
                    text.includes(outputPath),
                    `Expected saved path in response, got: ${text}`
                );
                const stat = await fs.stat(outputPath);
                assert.ok(
                    stat.size > 100,
                    `Expected screenshot file to contain data, got ${stat.size} bytes`
                );
            } finally {
                await fs.rm(outputPath, { force: true });
            }
        });

        it('should reject screenshot paths outside the working directory', async () => {
            const result = await client.callTool('take_screenshot', {
                outputPath: '/tmp/mcp-selenium-outside.png',
            });
            const text = getResponseText(result);
            assert.strictEqual(
                result.isError,
                true,
                'Expected isError: true for outside outputPath'
            );
            assert.ok(
                text.includes('inside'),
                `Expected directory restriction message, got: ${text}`
            );
        });
    });

    describe('multi-session', () => {
        it('should operate two sessions independently by sessionId', async () => {
            // Start first session
            const first = await client.callTool('start_browser', {
                browser: 'chrome',
                options: { headless: true, arguments: ['--no-sandbox'] },
            });
            const firstText = getResponseText(first);
            const firstId = firstText.match(/session_id: (\S+)/)?.[1];
            assert.ok(firstId, `Expected session_id, got: ${firstText}`);

            // Navigate in first session
            await client.callTool('navigate', { url: fixture('locators.html') });

            // Start second session — this should become the active one
            const second = await client.callTool('start_browser', {
                browser: 'chrome',
                options: { headless: true, arguments: ['--no-sandbox'] },
            });
            const secondText = getResponseText(second);
            const secondId = secondText.match(/session_id: (\S+)/)?.[1];
            assert.ok(secondId, `Expected session_id, got: ${secondText}`);
            assert.notEqual(firstId, secondId, 'Second session should have a different ID');

            // Navigate in second session to a different page
            await client.callTool('navigate', { url: fixture('interactions.html') });

            // Close the current (second) session explicitly.
            const closeResult = await client.callTool('close_session', { sessionId: secondId });
            const closeText = getResponseText(closeResult);
            assert.ok(
                closeText.includes(secondId),
                `Expected second session ID in close message, got: ${closeText}`
            );

            // The first session remains independently addressable.
            const result = await client.callTool('navigate', {
                sessionId: firstId,
                url: fixture('locators.html'),
            });
            const text = getResponseText(result);
            assert.ok(
                text.includes('Navigated'),
                `Expected first session to remain usable, got: ${text}`
            );
            await client.callTool('close_session', { sessionId: firstId });
        });
    });
});
