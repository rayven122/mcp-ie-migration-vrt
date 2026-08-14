import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema.sql');

// node:sqlite hands back rows with a null prototype, which breaks spreads,
// assert.deepEqual and anything reaching for Object.prototype. Normalizing here
// means no caller has to know that.
function plain(row) {
    return row === undefined ? undefined : { ...row };
}

/**
 * Opens a store and applies the schema. Pass ':memory:' for tests.
 *
 * The returned object is deliberately thin: this prototype writes SQL by hand
 * so it stays readable against Postgres later, rather than growing a query
 * builder we would have to port.
 */
export function openDatabase(path = ':memory:') {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(readFileSync(schemaPath, 'utf8'));

    return {
        /** Rows as plain objects. */
        all(sql, ...params) {
            return db
                .prepare(sql)
                .all(...params)
                .map(plain);
        },

        /** First row as a plain object, or undefined. */
        get(sql, ...params) {
            return plain(db.prepare(sql).get(...params));
        },

        run(sql, ...params) {
            return db.prepare(sql).run(...params);
        },

        exec(sql) {
            db.exec(sql);
        },

        /**
         * Runs fn inside a transaction. Ingestion has to be all-or-nothing:
         * a half-applied document would leave a fact timeline with a gap, and
         * a gap reads as "this value was never reported" rather than as an error.
         */
        transaction(fn) {
            db.exec('BEGIN');
            try {
                const result = fn();
                db.exec('COMMIT');
                return result;
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },

        close() {
            db.close();
        },
    };
}
