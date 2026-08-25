/**
 * Reader for EDINET's CSV document format (type=5).
 *
 * Available since 2024 and much cheaper to work with than the XBRL package: the
 * contexts have already been flattened into columns, so the period and
 * consolidation of every figure are plain text instead of something to resolve
 * against a context definition.
 *
 * The file is UTF-16LE with a BOM and tab-delimited. Reading it as UTF-8 does not
 * fail loudly -- it yields mojibake column names, the header lookup misses, and
 * the document silently contributes nothing. Encoding is therefore detected from
 * the BOM rather than assumed.
 */

const COLUMNS = {
    elementId: '要素ID',
    itemName: '項目名',
    contextId: 'コンテキストID',
    relativeYear: '相対年度',
    consolidatedLabel: '連結・個別',
    periodLabel: '期間・時点',
    unitId: 'ユニットID',
    unitLabel: '単位',
    value: '値',
};

export class DocumentCsvError extends Error {
    constructor(message, detail) {
        super(message);
        this.name = 'DocumentCsvError';
        this.detail = detail;
    }
}

/**
 * Decodes document bytes, choosing the encoding from the byte order mark.
 *
 * EDINET ships UTF-16LE here and CP932 elsewhere, so guessing one globally would
 * corrupt the other.
 */
export function decodeDocumentBytes(bytes, { expect = COLUMNS.elementId } = {}) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    if (view[0] === 0xff && view[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(view.subarray(2));
    }
    if (view[0] === 0xfe && view[1] === 0xff) {
        return new TextDecoder('utf-16be').decode(view.subarray(2));
    }
    if (view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
        return new TextDecoder('utf-8').decode(view.subarray(3));
    }

    // No BOM. Byte-level heuristics do not work here: the real header starts with
    // 要素ID, and a NUL-every-other-byte test only holds for ASCII content, so it
    // reports UTF-8 for exactly the files that need UTF-16. Since the header we
    // require is known, decode both ways and keep whichever actually produces it.
    for (const encoding of ['utf-8', 'utf-16le']) {
        const text = new TextDecoder(encoding).decode(view);
        if (text.includes(expect)) {
            return text;
        }
    }

    // Neither worked. Return the UTF-8 reading and let the parser raise a clear
    // error rather than guessing at a third encoding.
    return new TextDecoder('utf-8').decode(view);
}

/**
 * Parses decoded document text into rows the normalizer accepts.
 *
 * Quoted fields are honoured because item names contain tabs and quotes. Columns
 * are located by header name: a missing required column throws rather than
 * producing rows of undefined that would look like a company simply disclosing
 * nothing.
 */
export function parseDocumentCsv(text, { delimiter = '\t' } = {}) {
    const rows = splitDelimited(text, delimiter);
    if (rows.length === 0) {
        throw new DocumentCsvError('document is empty');
    }

    const headerIndex = rows.findIndex((row) =>
        row.some((cell) => cell.trim() === COLUMNS.elementId)
    );
    if (headerIndex === -1) {
        throw new DocumentCsvError(
            'header row not found; the document may have been decoded with the wrong encoding',
            { firstRow: rows[0]?.slice(0, 5) }
        );
    }

    const header = rows[headerIndex].map((cell) => cell.trim());
    const indices = {};
    const missing = [];

    for (const [key, label] of Object.entries(COLUMNS)) {
        const index = header.indexOf(label);
        if (index === -1) {
            if (
                ['elementId', 'relativeYear', 'consolidatedLabel', 'unitLabel', 'value'].includes(
                    key
                )
            ) {
                missing.push(label);
            }
            continue;
        }
        indices[key] = index;
    }

    if (missing.length > 0) {
        throw new DocumentCsvError(`missing required columns: ${missing.join(', ')}`, { header });
    }

    return rows
        .slice(headerIndex + 1)
        .filter((row) => (row[indices.elementId] ?? '').trim() !== '')
        .map((row) => {
            const record = {};
            for (const [key, index] of Object.entries(indices)) {
                record[key] = (row[index] ?? '').trim();
            }
            return record;
        });
}

function splitDelimited(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];

        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                field += ch;
            }
            continue;
        }

        if (ch === '"') {
            quoted = true;
        } else if (ch === delimiter) {
            row.push(field);
            field = '';
        } else if (ch === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else if (ch !== '\r') {
            field += ch;
        }
    }

    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}
