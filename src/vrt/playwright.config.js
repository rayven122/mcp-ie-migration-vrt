import { defineConfig } from '@playwright/test';

const runDirectory = process.env.MCP_VRT_RUN_DIR;

if (!runDirectory) {
    throw new Error('MCP_VRT_RUN_DIR is required');
}

export default defineConfig({
    testDir: '.',
    testMatch: 'compare.spec.js',
    workers: 1,
    reporter: [['json', { outputFile: `${runDirectory}/report.json` }]],
    outputDir: `${runDirectory}/test-results`,
    snapshotPathTemplate: `${runDirectory}/baseline/{arg}{ext}`,
});
