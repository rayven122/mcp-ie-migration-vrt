import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = new Set(['.mjs', '.json', '.sql', '.md']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

function sourceFiles(dir = ROOT, found = []) {
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) {
            continue;
        }
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            sourceFiles(path, found);
        } else if (EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
            found.push(path);
        }
    }
    return found;
}

/**
 * A literal control byte in source is not a syntax error and not something grep
 * or a formatter complains about, so it survives review unnoticed -- and it makes
 * git classify the file as binary, which replaces the diff with "Binary files
 * differ". Two of this prototype's core files reached the pull request in exactly
 * that state, unreviewable, because a NUL was used as a map-key separator by
 * writing the byte instead of the \u0000 escape.
 *
 * Tab, newline and carriage return are the only control characters source needs.
 */
test('no source file contains a literal control byte', () => {
    const offenders = [];

    for (const path of sourceFiles()) {
        const bytes = readFileSync(path);
        const positions = [];

        for (let i = 0; i < bytes.length; i += 1) {
            const byte = bytes[i];
            const allowed = byte === 0x09 || byte === 0x0a || byte === 0x0d;
            if (byte < 0x20 && !allowed) {
                positions.push({ offset: i, byte: `0x${byte.toString(16).padStart(2, '0')}` });
            }
        }

        if (positions.length > 0) {
            offenders.push({ file: relative(ROOT, path), positions: positions.slice(0, 5) });
        }
    }

    assert.deepEqual(
        offenders,
        [],
        `control bytes make git treat these files as binary and their diffs unreviewable. ` +
            `Write the value as an escape (\\u0000) instead of the byte: ${JSON.stringify(offenders)}`
    );
});

// Guards the fix itself: the separator must stay an escape, and stay a character
// that cannot occur inside an EDINET code, field name or year.
test('composite map keys use an escaped separator', () => {
    for (const relativePath of ['src/store/facts.mjs', 'src/normalize/index.mjs']) {
        const text = readFileSync(join(ROOT, relativePath), 'utf8');
        assert.match(text, /const KEY_SEPARATOR = '\\u0000';/, `${relativePath} should declare it`);
        assert.ok(!text.includes('\u0000'), `${relativePath} should not hold the raw byte`);
    }
});
