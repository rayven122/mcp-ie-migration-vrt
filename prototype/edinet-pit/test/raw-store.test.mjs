import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { createEdinetClient } from '../src/edinet/client.mjs';
import { ingestRange, renormalize } from '../src/ingest.mjs';
import { getFinancials } from '../src/query/financials.mjs';
import { openDatabase } from '../src/store/db.mjs';
import { createRawStore, RawStoreError } from '../src/store/raw.mjs';

const workspaces = [];

function workspace() {
    const dir = mkdtempSync(join(tmpdir(), 'edinet-pit-raw-'));
    workspaces.push(dir);
    return dir;
}

after(() => {
    for (const dir of workspaces) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function utf16le(text) {
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        bytes[2 + i * 2] = code & 0xff;
        bytes[3 + i * 2] = code >> 8;
    }
    return bytes;
}

const HEADER = ['要素ID', 'コンテキストID', '相対年度', '連結・個別', '単位', '値'].join('\t');

const DOCUMENT = utf16le(
    [
        HEADER,
        ['jppfs_cor:NetSales', 'CurrentYearDuration', '当期', '連結', '百万円', '45000'].join('\t'),
        ['jppfs_cor:Assets', 'CurrentYearInstant', '当期', '連結', '百万円', '80000'].join('\t'),
    ].join('\r\n')
);

const LISTING = [
    {
        docID: 'S100ORIG',
        edinetCode: 'E99999',
        docTypeCode: '120',
        periodStart: '2023-04-01',
        periodEnd: '2024-03-31',
        submitDateTime: '2024-06-20 15:30',
    },
];

/** Counts every request so a test can assert the network was never touched. */
function countingClient() {
    const calls = [];

    const transport = async (url) => {
        calls.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/documents.json')) {
            const date = parsed.searchParams.get('date');
            return {
                ok: true,
                status: 200,
                json: async () => ({ results: date === '2024-06-20' ? LISTING : [] }),
            };
        }
        return { ok: true, status: 200, arrayBuffer: async () => DOCUMENT.buffer };
    };

    return {
        calls,
        client: createEdinetClient({
            subscriptionKey: 'k',
            transport,
            minIntervalMs: 0,
            wait: async () => {},
        }),
    };
}

describe('content-addressed object store', () => {
    test('storing the same bytes twice yields one object', () => {
        const store = createRawStore({ root: workspace() });

        const first = store.put(DOCUMENT);
        const second = store.put(DOCUMENT);

        assert.equal(first, second);
        assert.equal(
            store.stats().objects,
            1,
            're-fetching unchanged content must not grow the lake'
        );
    });

    test('different bytes get different keys', () => {
        const store = createRawStore({ root: workspace() });

        assert.notEqual(store.put(DOCUMENT), store.put(utf16le('something else')));
        assert.equal(store.stats().objects, 2);
    });

    test('stored bytes come back unchanged', () => {
        const store = createRawStore({ root: workspace() });
        const key = store.put(DOCUMENT);

        assert.deepEqual(store.get(key), DOCUMENT);
        assert.equal(store.has(key), true);
    });

    // This store is the only copy, so being able to detect rot matters: silent
    // corruption would surface later as inexplicably changed figures.
    test('a corrupted object fails verification', () => {
        const root = workspace();
        const store = createRawStore({ root });
        const key = store.put(DOCUMENT);

        assert.equal(store.verify(key), true);
        writeFileSync(join(root, key.slice(0, 2), key), 'tampered');
        assert.equal(store.verify(key), false);
    });

    test('a missing object is an error, not empty bytes', () => {
        const store = createRawStore({ root: workspace() });
        assert.throws(() => store.get('0'.repeat(64)), RawStoreError);
    });

    test('a root is required', () => {
        assert.throws(() => createRawStore({}), RawStoreError);
    });
});

describe('re-normalizing from the lake', () => {
    let db;
    let store;

    beforeEach(() => {
        db = openDatabase(':memory:');
        store = createRawStore({ root: workspace() });
    });

    async function ingestOnce(client) {
        for await (const _day of ingestRange(db, client, {
            from: '2024-06-20',
            to: '2024-06-20',
            rawStore: store,
        })) {
            // drain
        }
    }

    test('ingestion records the object key alongside the document', async () => {
        const { client } = countingClient();
        await ingestOnce(client);

        const [row] = db.all('SELECT raw_object_key FROM documents');
        assert.match(row.raw_object_key, /^[0-9a-f]{64}$/);
        assert.equal(store.has(row.raw_object_key), true);
    });

    // The whole point: correcting the pipeline must not mean re-downloading years
    // of documents from a public service.
    test('re-normalizing makes no requests at all', async () => {
        const { client, calls } = countingClient();
        await ingestOnce(client);

        const requestsAfterIngest = calls.length;
        assert.ok(requestsAfterIngest > 0, 'ingestion should have used the network');

        const results = renormalize(db, store);

        assert.equal(results.length, 1);
        assert.equal(results[0].facts > 0, true);
        assert.equal(
            calls.length,
            requestsAfterIngest,
            're-normalization must not touch the network'
        );
    });

    test('re-normalizing with unchanged rules leaves the facts identical', async () => {
        const { client } = countingClient();
        await ingestOnce(client);

        const before = getFinancials(db, { companyIds: ['E99999'] });
        renormalize(db, store);
        const after = getFinancials(db, { companyIds: ['E99999'] });

        assert.deepEqual(after, before);
    });

    // A mapping fix has to reach history. Passing a different basis is the
    // smallest way to prove the re-derivation is genuinely re-running the rules.
    test('re-normalizing applies changed rules to stored documents', async () => {
        const { client } = countingClient();
        await ingestOnce(client);

        const asJpGaap = getFinancials(db, { companyIds: ['E99999'] });
        assert.ok(asJpGaap.rows.some((row) => row.accountingBasis === 'jp_gaap'));

        // Re-run forcing IFRS: the JP GAAP element IDs no longer resolve under that
        // mapping list, so the previously mapped fields drop out.
        renormalize(db, store, { accountingBasis: 'ifrs' });

        const reread = getFinancials(db, { companyIds: ['E99999'] });
        assert.notDeepEqual(reread, asJpGaap, 'changed rules should change the output');
    });

    test('a document with no stored bytes is left alone', async () => {
        const { client } = countingClient();
        await ingestOnce(client);
        db.run('UPDATE documents SET raw_object_key = NULL');

        assert.deepEqual(renormalize(db, store), []);
    });

    test('a lake object gone missing is reported per document, not thrown', async () => {
        const { client } = countingClient();
        await ingestOnce(client);

        const [row] = db.all('SELECT raw_object_key FROM documents');
        rmSync(join(store.root, row.raw_object_key.slice(0, 2), row.raw_object_key));

        const [result] = renormalize(db, store);
        assert.match(result.error, /not in the lake/);
    });

    test('ingestion still works without a lake configured', async () => {
        const { client } = countingClient();
        for await (const _day of ingestRange(db, client, {
            from: '2024-06-20',
            to: '2024-06-20',
        })) {
            // drain
        }

        const [row] = db.all('SELECT raw_object_key FROM documents');
        assert.equal(row.raw_object_key, null);
        assert.ok(getFinancials(db, { companyIds: ['E99999'] }).rows.length > 0);
    });

    test('the lake holds the original bytes byte for byte', async () => {
        const { client } = countingClient();
        await ingestOnce(client);

        const [row] = db.all('SELECT raw_object_key FROM documents');
        const stored = readFileSync(
            join(store.root, row.raw_object_key.slice(0, 2), row.raw_object_key)
        );
        assert.deepEqual(new Uint8Array(stored), DOCUMENT);
    });
});
