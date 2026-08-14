/**
 * Company master, loaded from EDINET's code list.
 *
 * Two things depend on this table being populated, and neither fails loudly when
 * it is empty. Group scope resolution reads the parent's corporate number from
 * here, so an empty master silently narrows every group to its recorded members.
 * And delisting status lives here, which is what keeps survivorship bias out of
 * any statistic computed over the data: measuring only companies that still exist
 * overstates profitability, and that is disqualifying for backtests and academic
 * work alike.
 *
 * Parsing is not repeated here -- parseCodeList in ./codelist.mjs produces the
 * records, and upsertCompany in ../store/gbiz.mjs writes them.
 */

import { upsertCompany } from '../store/gbiz.mjs';

/**
 * Writes code list records into the company master.
 *
 * Idempotent: the list is a full snapshot, so loading the same one twice must not
 * change anything.
 */
export function loadCompanyMaster(db, records, options = {}) {
    const { observedAt } = options;
    let written = 0;

    db.transaction(() => {
        for (const record of records) {
            if (!record.edinetCode) {
                continue;
            }
            upsertCompany(db, {
                edinetCode: record.edinetCode,
                secCode: record.secCode || null,
                corporateNumber: record.corporateNumber || null,
                name: record.name ?? record.edinetCode,
                industry: record.industry || null,
                listingStatus: record.isListed ? 'listed' : 'unlisted',
            });
            written += 1;
        }

        if (observedAt) {
            recordSnapshot(db, records, observedAt);
        }
    });

    return { written };
}

/**
 * Notes which companies were listed at a given observation.
 *
 * EDINET publishes only the current code list -- there is no archive of past
 * ones -- so listing history cannot be reconstructed backwards. It can only be
 * accumulated from the first time we look. Recording each snapshot is what makes
 * the next comparison possible.
 */
function recordSnapshot(db, records, observedAt) {
    for (const record of records) {
        if (!record.edinetCode) {
            continue;
        }
        db.run(
            `INSERT INTO company_snapshots (observed_at, edinet_code, sec_code, listed)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (observed_at, edinet_code) DO UPDATE SET
                sec_code = excluded.sec_code,
                listed = excluded.listed`,
            observedAt,
            record.edinetCode,
            record.secCode || null,
            record.isListed ? 1 : 0
        );
    }
}

/**
 * Marks companies that stopped being listed between the previous snapshot and
 * this one.
 *
 * Two ways a company leaves: it disappears from the list entirely, or it stays as
 * a filer but loses its securities code, which is what a management buyout looks
 * like from here. Both are delistings for the purpose of keeping a
 * survivorship-free universe, and the second is easy to miss because the company
 * is still present.
 *
 * The date recorded is the observation, not the actual delisting -- we learn about
 * it when we next look. Naming it observed rather than exact keeps that honest.
 */
export function reconcileDelistings(db, records, { observedAt }) {
    if (!observedAt) {
        throw new Error('observedAt is required to date a delisting');
    }

    const previous = db.get(
        'SELECT MAX(observed_at) AS at FROM company_snapshots WHERE observed_at < ?',
        observedAt
    );
    if (!previous?.at) {
        // Nothing to compare against yet. History starts accumulating from here.
        return { delisted: [], comparedTo: null };
    }

    const wasListed = db.all(
        'SELECT edinet_code, sec_code FROM company_snapshots WHERE observed_at = ? AND listed = 1',
        previous.at
    );

    const nowListed = new Map(
        records.filter((record) => record.isListed).map((record) => [record.edinetCode, record])
    );

    const delisted = [];
    db.transaction(() => {
        for (const row of wasListed) {
            if (nowListed.has(row.edinet_code)) {
                continue;
            }
            const stillFiling = records.some((record) => record.edinetCode === row.edinet_code);
            const reason = stillFiling ? 'securities_code_removed' : 'absent_from_code_list';

            db.run(
                `UPDATE companies
                 SET listing_status = 'delisted',
                     delisted_at = COALESCE(delisted_at, ?),
                     delisting_reason = COALESCE(delisting_reason, ?)
                 WHERE edinet_code = ?`,
                observedAt,
                reason,
                row.edinet_code
            );
            delisted.push({ edinetCode: row.edinet_code, reason });
        }
    });

    return { delisted, comparedTo: previous.at };
}

/**
 * The survivorship-free universe: everything ever observed as listed, with its
 * status. Restricting a study to `listing_status = 'listed'` is precisely the
 * mistake this table exists to make visible.
 */
export function getUniverse(db, options = {}) {
    const conditions = [];
    const params = [];

    if (options.listedOnly) {
        conditions.push("listing_status = 'listed'");
    }
    if (options.asOf) {
        // Listed at that time means: not yet known to have left.
        conditions.push('(delisted_at IS NULL OR delisted_at > ?)');
        params.push(options.asOf);
    }

    return db.all(
        `SELECT edinet_code, sec_code, corporate_number, name, industry,
                listing_status, delisted_at, delisting_reason
         FROM companies
         ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY edinet_code`,
        ...params
    );
}
