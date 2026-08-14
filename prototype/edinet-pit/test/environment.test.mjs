import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

// node:sqlite はこのプロトタイプのストア基盤。使えなければ以降すべてが成立しないため、
// 依存の有無ではなく「実際に読み書きできること」を確かめる。
test('node:sqlite can create a table and round-trip a row', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE probe (key TEXT PRIMARY KEY, value NUMERIC)');
    db.prepare('INSERT INTO probe (key, value) VALUES (?, ?)').run('net_sales', 45095325);

    const rows = db.prepare('SELECT key, value FROM probe').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, 'net_sales');
    assert.equal(rows[0].value, 45095325);
    db.close();
});

// node:sqlite が返す行は null プロトタイプ。素の deepEqual が通らず、スプレッドや
// Object.prototype 由来のメソッドを前提にしたコードも壊れる。ストア層で必ず
// 通常のオブジェクトへ正規化する必要があるため、その前提をここで固定する。
test('rows come back with a null prototype and need normalizing', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE probe (key TEXT)');
    db.prepare('INSERT INTO probe (key) VALUES (?)').run('net_sales');

    const [row] = db.prepare('SELECT key FROM probe').all();
    assert.equal(Object.getPrototypeOf(row), null);
    assert.deepEqual({ ...row }, { key: 'net_sales' });
    db.close();
});

// PITクエリは NULL を「まだ閉じていない現行値」として扱う。SQLite の三値論理が
// 期待どおりでないと as_of の絞り込みが静かに壊れるので、意味論を先に固定する。
test('NULL upper bound behaves as an open interval in as_of filtering', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE span (label TEXT, known_from TEXT, known_until TEXT)');
    const insert = db.prepare('INSERT INTO span VALUES (?, ?, ?)');
    insert.run('original', '2024-06-20T00:00:00Z', '2024-11-05T00:00:00Z');
    insert.run('restated', '2024-11-05T00:00:00Z', null);

    const asOf = db.prepare(
        'SELECT label FROM span WHERE known_from <= ? AND (known_until IS NULL OR known_until > ?)'
    );

    const labelsAt = (t) => asOf.all(t, t).map((r) => r.label);

    assert.deepEqual(labelsAt('2024-08-01T00:00:00Z'), ['original']);
    assert.deepEqual(labelsAt('2025-01-01T00:00:00Z'), ['restated']);
    // 訂正の境界時刻はちょうど新しい行に切り替わる（半開区間 [from, until)）
    assert.deepEqual(labelsAt('2024-11-05T00:00:00Z'), ['restated']);
    db.close();
});
