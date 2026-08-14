/**
 * Raw data lake: the untouched bytes of everything fetched.
 *
 * The normalization rules will change repeatedly -- a mapping gains entries after
 * every taxonomy revision, a context rule turns out to drop parent-only figures,
 * a unit is mis-scaled. Each of those fixes has to be applied to all history, and
 * without the original bytes on hand that means re-downloading ten years from a
 * public API every time. That is impractical and discourteous, so keeping the
 * originals is what makes the pipeline correctable at all.
 *
 * Content-addressed by SHA-256: re-fetching a document that has not changed costs
 * no extra space, and a stored object can always be verified against its own key.
 * Node's crypto and fs only, to keep the prototype dependency-free.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class RawStoreError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RawStoreError';
    }
}

function digestOf(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {object} options
 * @param {string} options.root  Directory to hold the objects.
 */
export function createRawStore({ root }) {
    if (!root) {
        throw new RawStoreError('root is required');
    }

    /**
     * Objects are filed under the first two hex characters of their digest.
     * A single flat directory with hundreds of thousands of entries is slow to
     * list and unpleasant on most filesystems.
     */
    function pathFor(key) {
        return join(root, key.slice(0, 2), key);
    }

    return {
        root,

        /**
         * Stores bytes and returns their key.
         *
         * Writing the same content twice is a no-op rather than a duplicate, which
         * is what makes re-running a backfill cheap.
         */
        put(bytes) {
            const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            const key = digestOf(view);
            const path = pathFor(key);

            if (!existsSync(path)) {
                mkdirSync(join(root, key.slice(0, 2)), { recursive: true });
                writeFileSync(path, view);
            }
            return key;
        },

        get(key) {
            const path = pathFor(key);
            if (!existsSync(path)) {
                throw new RawStoreError(`object not in the lake: ${key}`);
            }
            return new Uint8Array(readFileSync(path));
        },

        has(key) {
            return existsSync(pathFor(key));
        },

        /**
         * Recomputes the digest of a stored object and compares it to its key.
         *
         * Worth having because this store is the only copy: if it rots, the ability
         * to re-derive anything rots with it, and silent corruption would surface
         * as inexplicably changed figures.
         */
        verify(key) {
            return digestOf(this.get(key)) === key;
        },

        stats() {
            if (!existsSync(root)) {
                return { objects: 0, bytes: 0 };
            }
            let objects = 0;
            let bytes = 0;
            for (const prefix of readdirSync(root)) {
                const dir = join(root, prefix);
                if (!statSync(dir).isDirectory()) {
                    continue;
                }
                for (const name of readdirSync(dir)) {
                    objects += 1;
                    bytes += statSync(join(dir, name)).size;
                }
            }
            return { objects, bytes };
        },
    };
}
