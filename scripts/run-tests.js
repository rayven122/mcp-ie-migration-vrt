import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Test directories to run. Prototypes keep their suites beside their own source. */
const suites = ['test'];

if (existsSync('prototype')) {
    for (const name of readdirSync('prototype').sort()) {
        const dir = join('prototype', name, 'test');
        if (existsSync(dir)) {
            suites.push(dir);
        }
    }
}

for (const suite of suites) {
    const tests = readdirSync(suite)
        .filter((name) => name.endsWith('.test.mjs') && name !== 'all.test.mjs')
        .sort();

    for (const test of tests) {
        execFileSync(process.execPath, ['--test', join(suite, test)], {
            stdio: 'inherit',
        });
    }
}
