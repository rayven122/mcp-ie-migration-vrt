/**
 * Unit and sign normalization.
 *
 * Filings mix 円, 千円 and 百万円 freely, and a value is meaningless without its
 * scale. Everything monetary is converted to plain yen: it is the only scale that
 * loses no precision, and presentation can divide later. Percentages, share
 * counts and headcounts are left as reported -- rescaling those would be magic
 * a reader cannot see.
 */

const MONETARY_SCALES = new Map([
    ['円', 1],
    ['千円', 1_000],
    ['百万円', 1_000_000],
    ['十億円', 1_000_000_000],
]);

const PASSTHROUGH_UNITS = new Map([
    ['株', 'SHARES'],
    ['人', 'PERSONS'],
    ['名', 'PERSONS'],
    ['％', 'PERCENT'],
    ['%', 'PERCENT'],
    ['件', 'COUNT'],
    ['社', 'COUNT'],
]);

export class UnrecognizedUnitError extends Error {
    constructor(unitLabel) {
        super(`unrecognized unit: ${JSON.stringify(unitLabel)}`);
        this.name = 'UnrecognizedUnitError';
        this.unitLabel = unitLabel;
    }
}

/**
 * Parses a reported value.
 *
 * EDINET CSV writes an absent figure as an empty string or a dash, which is not
 * the same as zero -- "not disclosed" and "zero" must not collapse into each
 * other, so an absent figure comes back as null.
 */
export function parseValue(raw) {
    if (raw === null || raw === undefined) {
        return null;
    }
    const text = String(raw).trim().replace(/,/g, '');
    if (text === '' || text === '-' || text === '－' || text === '―') {
        return null;
    }
    // Parentheses are sometimes used for negatives instead of a minus sign.
    const parenthesized = /^\((.+)\)$/.exec(text);
    const signed = parenthesized ? `-${parenthesized[1]}` : text;

    const value = Number(signed);
    return Number.isFinite(value) ? value : null;
}

/**
 * Converts a raw value plus its Japanese unit label into a canonical
 * (value, unit) pair. `negate` flips the sign for elements whose reported
 * convention is the opposite of the canonical field -- loss elements are
 * reported as positive numbers.
 */
export function normalizeUnit(raw, unitLabel, options = {}) {
    const { negate = false } = options;
    const parsed = parseValue(raw);
    const label = String(unitLabel ?? '').trim();

    const scale = MONETARY_SCALES.get(label);
    if (scale !== undefined) {
        const value = parsed === null ? null : parsed * scale * (negate ? -1 : 1);
        return { value, unit: 'JPY' };
    }

    const passthrough = PASSTHROUGH_UNITS.get(label);
    if (passthrough !== undefined) {
        const value = parsed === null ? null : parsed * (negate ? -1 : 1);
        return { value, unit: passthrough };
    }

    // Refusing beats guessing: an unknown unit means the taxonomy moved, and a
    // silently mis-scaled figure is worse than a missing one.
    throw new UnrecognizedUnitError(unitLabel);
}

export const RECOGNIZED_UNIT_LABELS = [...MONETARY_SCALES.keys(), ...PASSTHROUGH_UNITS.keys()];
