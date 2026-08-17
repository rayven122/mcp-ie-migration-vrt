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
        assert.deepEqual(response.capture.requested, { width: 800, height: 600 });
        assert.deepEqual(response.capture.before, { width: 800, height: 600 });
        assert.deepEqual(response.capture.after, { width: 800, height: 600 });
        assert.equal(response.capture.dimensionMismatch, false);
        assert.deepEqual(response.returnedImages, ['before', 'after']);
        assert.deepEqual(result.structuredContent, response);
        assert.deepEqual(
            result.content.filter((entry) => entry.type === 'image').map((entry) => entry.mimeType),
            ['image/png', 'image/png']
        );
        assert.ok(response.artifacts.runDirectory.startsWith(artifactRoot));
        await fs.access(response.artifacts.before);
        await fs.access(response.artifacts.after);
        await fs.access(response.artifacts.report);
    });

    it('returns source and diff images for AI review', async () => {
        const beforeSessionId = sessions[0];
        const afterSessionId = sessions[1];
        await client.callTool('execute_script', {
            sessionId: afterSessionId,
            script: `document.body.style.backgroundColor = 'rgb(255, 0, 0)'; return true;`,
        });

        const result = await client.callTool('vrt', {
            beforeSessionId,
            afterSessionId,
            name: 'intentional-difference',
            width: 800,
            height: 600,
            maxDiffPixelRatio: 0,
            threshold: 0.1,
            outputDirectory: artifactRoot,
        });
        const response = JSON.parse(getResponseText(result));
        assert.equal(result.isError, undefined, JSON.stringify(result, null, 2));
        assert.equal(response.status, 'different');
        assert.equal(response.review.required, true);
        assert.ok(response.review.reasons.includes('pixels-differ'));
        assert.deepEqual(response.returnedImages, ['before', 'after', 'diff']);
        assert.deepEqual(result.structuredContent, response);

        const labels = result.content
            .filter((entry) => entry.type === 'text' && entry.text.startsWith('VRT image:'))
            .map((entry) => entry.text);
        assert.deepEqual(labels, ['VRT image: before', 'VRT image: after', 'VRT image: diff']);
        const images = result.content.filter((entry) => entry.type === 'image');
        assert.equal(images.length, 3);
        assert.ok(
            images.every((entry) => entry.mimeType === 'image/png' && entry.data.length > 100)
        );
        await fs.access(response.artifacts.diff);
    });

    it('returns a diff instead of an error when screenshot dimensions differ', async () => {
        const scaled = await client.callTool('start_browser', {
            browser: 'chrome',
            options: {
                headless: true,
                arguments: ['--no-sandbox', '--force-device-scale-factor=1.25'],
            },
        });
        const scaledSessionId = sessionIdFrom(scaled);
        assert.ok(scaledSessionId);
        sessions.push(scaledSessionId);
        await client.callTool('navigate', {
            sessionId: scaledSessionId,
            url: fixture('locators.html'),
        });

        const result = await client.callTool('vrt', {
            beforeSessionId: sessions[0],
            afterSessionId: scaledSessionId,
            name: 'different-pixel-dimensions',
            width: 800,
            height: 600,
            maxDiffPixelRatio: 0,
            threshold: 0.1,
            outputDirectory: artifactRoot,
            returnImages: 'diff',
        });
        const response = JSON.parse(getResponseText(result));
        assert.equal(result.isError, undefined, JSON.stringify(result, null, 2));
        assert.equal(response.status, 'different');
        assert.equal(response.capture.dimensionMismatch, true);
        assert.deepEqual(response.capture.before, { width: 800, height: 600 });
        assert.deepEqual(response.capture.after, { width: 1000, height: 750 });
        assert.ok(response.review.reasons.includes('capture-dimensions-differ'));
        assert.deepEqual(response.returnedImages, ['diff']);
        assert.equal(result.content.filter((entry) => entry.type === 'image').length, 1);
        await fs.access(response.artifacts.diff);
    });

    it('can omit images while retaining structured review evidence', async () => {
        const result = await client.callTool('vrt', {
            beforeSessionId: sessions[0],
            afterSessionId: sessions[1],
            name: 'difference-without-images',
            width: 800,
            height: 600,
            maxDiffPixelRatio: 0,
            threshold: 0.1,
            outputDirectory: artifactRoot,
            returnImages: 'none',
        });
        const response = JSON.parse(getResponseText(result));
        assert.equal(response.status, 'different');
        assert.deepEqual(response.returnedImages, []);
        assert.equal(
            result.content.some((entry) => entry.type === 'image'),
            false
        );
        assert.ok(response.artifacts.diff);
    });
});
