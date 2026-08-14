/**
 * Context selection.
 *
 * A single filing reports the same element many times over -- this year and the
 * two before it, consolidated and parent-only, actual and forecast, and once per
 * business segment. Picking the wrong one does not raise an error, it silently
 * produces a plausible number that is not the one anyone asked for. That is the
 * worst failure mode in this whole pipeline, so selection is explicit and
 * anything unrecognized is rejected rather than guessed at.
 */

// EDINET's CSV export labels the period in Japanese, relative to the filing.
const YEAR_OFFSETS = new Map([
    ['当期', 0],
    ['前期', -1],
    ['前々期', -2],
    ['前々々期', -3],
]);

const CONSOLIDATION = new Map([
    ['連結', true],
    ['個別', false],
    ['非連結', false],
]);

/**
 * Members that encode consolidation rather than a narrower slice. Parent-only
 * figures are tagged NonConsolidatedMember in real filings, so treating every
 * Member as a segment would silently discard all parent-only data -- which is
 * exactly what happened until running the fixtures showed those rows missing.
 */
const CONSOLIDATION_MEMBERS = /(NonConsolidatedMember|ConsolidatedMember)/g;

/**
 * Context IDs carrying a member axis describe a slice -- a segment, a forecast,
 * a subsidiary -- not the reporting entity's own figure. Prior periods and the
 * consolidation axis are already conveyed by their own columns, so any Member
 * left after removing those means "narrower than what we want".
 */
function hasMemberAxis(contextId) {
    return /Member/.test(String(contextId).replace(CONSOLIDATION_MEMBERS, ''));
}

function isForecast(contextId) {
    return /Forecast/.test(contextId);
}

/**
 * Decides whether a raw row describes a figure we want, and if so which period
 * and consolidation it belongs to.
 *
 * Returns null when the row should be skipped, with no attempt to salvage it.
 */
export function selectContext(row, options = {}) {
    const { includePriorYears = true } = options;

    if (hasMemberAxis(row.contextId)) {
        return null;
    }
    if (isForecast(row.contextId)) {
        return null;
    }

    const yearOffset = YEAR_OFFSETS.get(row.relativeYear);
    if (yearOffset === undefined) {
        return null;
    }
    if (!includePriorYears && yearOffset !== 0) {
        return null;
    }

    const consolidated = CONSOLIDATION.get(row.consolidatedLabel);
    if (consolidated === undefined) {
        return null;
    }

    return { yearOffset, consolidated };
}

/**
 * Exposed for tests and for reporting on rows the selector rejected, which is
 * how a taxonomy change shows up: coverage drops and the skipped labels are new.
 */
export const RECOGNIZED_PERIOD_LABELS = [...YEAR_OFFSETS.keys()];
export const RECOGNIZED_CONSOLIDATION_LABELS = [...CONSOLIDATION.keys()];
