-- EDINET point-in-time store.
--
-- Written to stay portable to Postgres: no AUTOINCREMENT, no SQLite-only types.
-- Timestamps are ISO 8601 UTC strings, which compare correctly as text in both
-- engines and keep the as_of predicate a plain range scan.

CREATE TABLE IF NOT EXISTS companies (
    edinet_code       TEXT PRIMARY KEY,
    sec_code          TEXT,
    corporate_number  TEXT,             -- 13 digits, as text: leading zeros are significant
    name              TEXT NOT NULL,
    industry          TEXT,
    accounting_basis  TEXT,             -- jp_gaap / ifrs / us_gaap, latest known
    listing_status    TEXT NOT NULL,    -- listed / delisted
    delisted_at       TEXT,
    delisting_reason  TEXT
);

CREATE INDEX IF NOT EXISTS companies_sec_code ON companies (sec_code);
CREATE INDEX IF NOT EXISTS companies_corporate_number ON companies (corporate_number);

-- One row per filed document. Amendments are separate documents that point at
-- what they amend, never updates to the original row.
CREATE TABLE IF NOT EXISTS documents (
    doc_id            TEXT PRIMARY KEY,
    edinet_code       TEXT NOT NULL,
    doc_type_code     TEXT NOT NULL,    -- 120 annual, 130 amended annual, 160 semi, ...
    period_start      TEXT,
    period_end        TEXT,
    fiscal_year       INTEGER,
    submitted_at      TEXT NOT NULL,    -- when this became knowable
    is_amendment      INTEGER NOT NULL,
    amends_doc_id     TEXT,
    raw_object_key    TEXT              -- where the untouched original is kept
);

CREATE INDEX IF NOT EXISTS documents_company_period ON documents (edinet_code, fiscal_year);
CREATE INDEX IF NOT EXISTS documents_submitted_at ON documents (submitted_at);

-- The bitemporal core.
--
-- A fact is not "the value of net sales for FY2023". It is "the value of net
-- sales for FY2023 *as it was knowable* between known_from and known_until".
-- A correction appends a row and closes the previous one; it never overwrites.
-- Several rows for one (company, year, field) is the normal, correct state --
-- that series *is* the restatement history.
CREATE TABLE IF NOT EXISTS facts (
    company_id        TEXT NOT NULL,
    fiscal_year       INTEGER NOT NULL,
    period_type       TEXT NOT NULL,    -- annual / semi / q
    consolidated      INTEGER NOT NULL, -- 0 = parent only, 1 = consolidated
    field_key         TEXT NOT NULL,    -- normalized metric name
    value             NUMERIC,
    unit              TEXT NOT NULL,    -- normalized, so values are comparable
    accounting_basis  TEXT NOT NULL,

    -- Provenance. Never dropped: this is what makes a number checkable, and it
    -- is also the only practical way to debug a normalization miss.
    source_doc_id     TEXT NOT NULL,
    source_element_id TEXT NOT NULL,

    -- Which name-resolution layer produced this: 'layer1' matched a published
    -- element ID, 'layer2' matched the element's name shape. A guess and a known
    -- mapping must stay distinguishable, or consumers cannot tell how much to
    -- trust a figure and coverage numbers become meaningless.
    mapping_layer     TEXT NOT NULL DEFAULT 'layer1',

    -- Knowledge time, not valid time.
    known_from        TEXT NOT NULL,
    known_until       TEXT,             -- NULL means "still current"
    is_amendment      INTEGER NOT NULL,

    PRIMARY KEY (
        company_id, fiscal_year, period_type, consolidated, field_key, known_from
    )
);

-- Serves the as_of predicate: known_from <= T AND (known_until IS NULL OR known_until > T)
CREATE INDEX IF NOT EXISTS facts_as_of
    ON facts (company_id, field_key, fiscal_year, known_from, known_until);

CREATE INDEX IF NOT EXISTS facts_source ON facts (source_doc_id);

-- What the code list said at each time we looked.
--
-- EDINET publishes only the current list, with no archive of past ones, so
-- listing history cannot be reconstructed backwards -- it can only accumulate
-- from the first observation onward. Keeping each snapshot is what makes the next
-- comparison, and therefore delisting detection, possible at all.
CREATE TABLE IF NOT EXISTS company_snapshots (
    observed_at   TEXT NOT NULL,
    edinet_code   TEXT NOT NULL,
    sec_code      TEXT,
    listed        INTEGER NOT NULL,

    PRIMARY KEY (observed_at, edinet_code)
);

CREATE INDEX IF NOT EXISTS company_snapshots_code ON company_snapshots (edinet_code);

-- Consolidated scope, needed because EDINET files under the parent while
-- gBizINFO records subsidies, procurement and patents under subsidiary names.
-- Membership changes over time, so the rows are period-scoped.
CREATE TABLE IF NOT EXISTS company_group (
    parent_edinet_code      TEXT NOT NULL,
    member_corporate_number TEXT NOT NULL,
    member_name             TEXT,
    relation                TEXT NOT NULL,  -- consolidated / equity_method / other
    source                  TEXT NOT NULL,  -- filing_related_companies / manual / ...
    valid_from              TEXT,
    valid_until             TEXT,

    PRIMARY KEY (parent_edinet_code, member_corporate_number, relation, valid_from)
);

-- gBizINFO records keyed by corporate number. fetched_at is required because
-- administrative data gets revised in place with no version of its own.
CREATE TABLE IF NOT EXISTS gbiz_facts (
    corporate_number  TEXT NOT NULL,
    category          TEXT NOT NULL,   -- subsidy / procurement / patent / ...
    record_key        TEXT NOT NULL,   -- stable id within the category
    event_date        TEXT,
    amount            NUMERIC,
    agency            TEXT,
    title             TEXT,
    raw_json          TEXT NOT NULL,
    fetched_at        TEXT NOT NULL,
    api_version       TEXT NOT NULL,

    PRIMARY KEY (corporate_number, category, record_key)
);

CREATE INDEX IF NOT EXISTS gbiz_facts_event_date ON gbiz_facts (category, event_date);
