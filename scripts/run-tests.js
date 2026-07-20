import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const tests = readdirSync('test')
    .filter((name) => name.endsWith('.test.mjs') && name !== 'all.test.mjs')
    .sort();

for (const test of tests) {
    execFileSync(process.execPath, ['--test', join('test', test)], {
        stdio: 'inherit',
    });
}
