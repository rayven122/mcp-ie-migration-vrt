/**
 * gBizINFO records and the company-group scope they have to be read through.
 *
 * The trap this module exists to handle: EDINET files under the parent company,
 * while subsidies, procurement and patents are awarded to whichever subsidiary
 * actually did the work. Looking up only the parent's corporate number therefore
 * understates a group badly -- R&D grants sit with a research subsidiary, tenders
 * with a sales company. Group membership also changes year to year, so it is
 * period-scoped rather than a fixed list.
 */

export function linkCorporateNumber(db, edinetCode, corporateNumber) {
    db.run(
        'UPDATE companies SET corporate_number = ? WHERE edinet_code = ?',
        corporateNumber,
        edinetCode
    );
}

export function upsertCompany(db, company) {
    db.run(
        `INSERT INTO companies (
            edinet_code, sec_code, corporate_number, name, industry,
            accounting_basis, listing_status, delisted_at, delisting_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (edinet_code) DO UPDATE SET
            sec_code = excluded.sec_code,
            corporate_number = excluded.corporate_number,
            name = excluded.name,
            industry = excluded.industry,
            accounting_basis = excluded.accounting_basis,
            listing_status = excluded.listing_status,
            delisted_at = excluded.delisted_at,
            delisting_reason = excluded.delisting_reason`,
        company.edinetCode,
        company.secCode ?? null,
        company.corporateNumber ?? null,
        company.name,
        company.industry ?? null,
        company.accountingBasis ?? null,
        company.listingStatus ?? 'listed',
        company.delistedAt ?? null,
        company.delistingReason ?? null
    );
}

export function recordGroupMembers(db, parentEdinetCode, members) {
    db.transaction(() => {
        for (const member of members) {
            db.run(
                `INSERT INTO company_group (
                    parent_edinet_code, member_corporate_number, member_name,
                    relation, source, valid_from, valid_until
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (parent_edinet_code, member_corporate_number, relation, valid_from)
                DO UPDATE SET
                    member_name = excluded.member_name,
                    source = excluded.source,
                    valid_until = excluded.valid_until`,
                parentEdinetCode,
                member.corporateNumber,
                member.name ?? null,
                member.relation ?? 'consolidated',
                member.source ?? 'filing_related_companies',
                member.validFrom ?? null,
                member.validUntil ?? null
            );
        }
    });
}

/**
 * Corporate numbers in a group's scope at a point in time, including the parent's.
 *
 * Returns a de-duplicated list. The same corporate number can appear under more
 * than one relation, or be reachable both as the parent and as a member, and every
 * caller downstream sums over this -- so a repeat here becomes double counting
 * that looks like a real number.
 */
export function getGroupCorporateNumbers(db, parentEdinetCode, options = {}) {
    const { asOf, relations = ['consolidated'] } = options;

    const conditions = ['parent_edinet_code = ?'];
    const params = [parentEdinetCode];

    if (relations.length > 0) {
        conditions.push(`relation IN (${relations.map(() => '?').join(', ')})`);
        params.push(...relations);
    }
    if (asOf) {
        conditions.push('(valid_from IS NULL OR valid_from <= ?)');
        conditions.push('(valid_until IS NULL OR valid_until > ?)');
        params.push(asOf, asOf);
    }

    const members = db.all(
        `SELECT DISTINCT member_corporate_number AS number
         FROM company_group WHERE ${conditions.join(' AND ')}`,
        ...params
    );

    const parent = db.get(
        'SELECT corporate_number AS number FROM companies WHERE edinet_code = ?',
        parentEdinetCode
    );

    const numbers = new Set(members.map((row) => row.number));
    if (parent?.number) {
        numbers.add(parent.number);
    }
    return [...numbers].sort();
}

export function recordGbizFacts(db, facts) {
    return db.transaction(() => {
        for (const fact of facts) {
            db.run(
                `INSERT INTO gbiz_facts (
                    corporate_number, category, record_key, event_date,
                    amount, agency, title, raw_json, fetched_at, api_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (corporate_number, category, record_key) DO UPDATE SET
                    event_date = excluded.event_date,
                    amount = excluded.amount,
                    agency = excluded.agency,
                    title = excluded.title,
                    raw_json = excluded.raw_json,
                    fetched_at = excluded.fetched_at,
                    api_version = excluded.api_version`,
                fact.corporateNumber,
                fact.category,
                fact.recordKey,
                fact.eventDate ?? null,
                fact.amount ?? null,
                fact.agency ?? null,
                fact.title ?? null,
                fact.raw,
                fact.fetchedAt,
                fact.apiVersion
            );
        }
        return facts.length;
    });
}

/**
 * Totals one category across a group's scope.
 *
 * `asOf` filters on the event date, so a subsidy awarded after the date is not
 * counted -- the same discipline the financial side applies, for the same reason:
 * a total that includes events the reader could not have known about is a
 * look-ahead leak.
 */
export function aggregateGbizByGroup(db, parentEdinetCode, category, options = {}) {
    const numbers = getGroupCorporateNumbers(db, parentEdinetCode, options);
    if (numbers.length === 0) {
        return { category, members: 0, records: 0, total: null };
    }

    const conditions = [
        `corporate_number IN (${numbers.map(() => '?').join(', ')})`,
        'category = ?',
    ];
    const params = [...numbers, category];

    if (options.asOf) {
        conditions.push('(event_date IS NULL OR event_date <= ?)');
        params.push(options.asOf);
    }

    const row = db.get(
        `SELECT COUNT(*) AS records, SUM(amount) AS total
         FROM gbiz_facts WHERE ${conditions.join(' AND ')}`,
        ...params
    );

    return {
        category,
        members: numbers.length,
        records: row?.records ?? 0,
        total: row?.total ?? null,
    };
}

/**
 * Public-procurement exposure: awarded value against revenue.
 *
 * EDINET segment disclosures do not separate public-sector revenue, so this ratio
 * is not available from filings alone. It is an estimate, and named as one --
 * award dates and revenue recognition do not line up period for period.
 */
export function estimateProcurementExposure(db, parentEdinetCode, { netSales, asOf } = {}) {
    const procurement = aggregateGbizByGroup(db, parentEdinetCode, 'procurement', { asOf });

    if (!netSales || procurement.total === null) {
        return { ...procurement, netSales: netSales ?? null, ratio: null };
    }
    return {
        ...procurement,
        netSales,
        ratio: procurement.total / netSales,
    };
}
