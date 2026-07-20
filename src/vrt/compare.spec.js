import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('compares Selenium screenshots', async () => {
    const actual = await readFile(process.env.MCP_VRT_ACTUAL_PATH);
    const maxDiffPixelRatio = Number(process.env.MCP_VRT_MAX_DIFF_PIXEL_RATIO || '0.005');
    const threshold = Number(process.env.MCP_VRT_THRESHOLD || '0.2');

    expect(actual).toMatchSnapshot('expected.png', {
        maxDiffPixelRatio,
        threshold,
    });
});
