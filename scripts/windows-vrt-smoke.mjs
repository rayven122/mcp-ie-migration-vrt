import { writeFile } from 'node:fs/promises';
import { getResponseText, McpClient } from '../test/mcp-client.mjs';

const baseUrl = process.env.VRT_SMOKE_URL ?? 'http://localhost:8088/Default.aspx';
const outputPath = process.env.VRT_SMOKE_OUTPUT ?? 'C:\\vrt-lab\\smoke-result.json';
const width = Number(process.env.VRT_SMOKE_WIDTH ?? 1200);
const height = Number(process.env.VRT_SMOKE_HEIGHT ?? 650);
const client = new McpClient(
    {
        MCP_VRT_ARTIFACT_DIR: process.env.MCP_VRT_ARTIFACT_DIR ?? 'C:\\vrt-lab\\artifacts',
    },
    120000
);
const report = { startedAt: new Date().toISOString(), baseUrl, steps: [] };

const call = async (name, args) => {
    const result = await client.callTool(name, args);
    const text = getResponseText(result);
    report.steps.push({ name, args, isError: Boolean(result.isError), text });
    if (result.isError) throw new Error(`${name}: ${text}`);
    return text;
};

try {
    await client.start();
    const pair = JSON.parse(
        await call('start_vrt_browsers', {
            beforeUrl: baseUrl,
            afterUrl: baseUrl,
            width,
            height,
            beforeOptions: { ieIgnoreZoomSetting: true },
        })
    );

    for (const [side, sessionId] of [
        ['before', pair.beforeSessionId],
        ['after', pair.afterSessionId],
    ]) {
        await call('execute_script', {
            sessionId,
            script: `return {side: '${side}', documentMode: document.documentMode || null, userAgent: navigator.userAgent, width: window.innerWidth, height: window.innerHeight, form: !!document.getElementById('MigrationForm')}`,
        });
        await call('interact', {
            sessionId,
            action: 'click',
            by: 'id',
            value: 'IncrementButton',
        });
        await call('get_element_text', {
            sessionId,
            by: 'id',
            value: 'CounterValue',
        });
    }

    await call('vrt', {
        beforeSessionId: pair.beforeSessionId,
        afterSessionId: pair.afterSessionId,
        name: 'vbnet-postback-equivalent',
        width,
        height,
        maxDiffPixelRatio: 0.005,
        threshold: 0.2,
    });

    await call('navigate', {
        sessionId: pair.afterSessionId,
        url: `${baseUrl}?variant=different`,
    });
    await call('interact', {
        sessionId: pair.afterSessionId,
        action: 'click',
        by: 'id',
        value: 'IncrementButton',
    });
    const intentionalDiff = await client.callTool('vrt', {
        beforeSessionId: pair.beforeSessionId,
        afterSessionId: pair.afterSessionId,
        name: 'vbnet-intentional-difference',
        width,
        height,
        maxDiffPixelRatio: 0,
        threshold: 0.1,
    });
    report.steps.push({
        name: 'vrt-intentional-difference',
        isError: Boolean(intentionalDiff.isError),
        text: getResponseText(intentionalDiff),
    });
    report.completed = true;
} catch (error) {
    report.completed = false;
    report.error = error instanceof Error ? error.stack : String(error);
} finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(outputPath, JSON.stringify(report, null, 2));
    await client.stop();
}

if (!report.completed) process.exitCode = 1;
