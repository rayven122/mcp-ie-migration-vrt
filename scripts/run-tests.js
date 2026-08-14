import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Prototypes are free to use newer platform APIs than the package itself
// supports -- the EDINET store builds on node:sqlite, which only exists from
// Node 22. The package targets Node >=18 and CI runs the matrix, so their
// suites are skipped rather than failing the older versions.
const PROTOTYPE_MIN_NODE_MAJOR = 22;
const nodeMajor = Number(process.versions.node.split('.')[0]);

const suites = ['test'];

if (existsSync('prototype')) {
    if (nodeMajor >= PROTOTYPE_MIN_NODE_MAJOR) {
        for (const name of readdirSync('prototype').sort()) {
            const dir = join('prototype', name, 'test');
            if (existsSync(dir)) {
                suites.push(dir);
            }
        }
    } else {
        console.log(`# skipping prototype suites: Node ${nodeMajor} < ${PROTOTYPE_MIN_NODE_MAJOR}`);
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
