/**
 * Layer 2 of name resolution: pattern matching on the element's local name.
 *
 * Layer 1 only knows element IDs published in the standard taxonomy. Filers --
 * IFRS adopters especially -- define their own extension elements under their own
 * namespace prefix, and those IDs differ per company, so no fixed list can cover
 * them. Their local names, however, are usually built from the same English words
 * as the standard elements.
 *
 * This layer is a guess, and it is labelled as one. Facts resolved here are
 * marked mappingLayer: 'layer2' so a consumer can exclude them, and so coverage
 * can be reported separately for known versus inferred names. A regex that
 * quietly outvoted a real element ID would be indistinguishable from correct
 * data, which is why layer 1 always wins and this only runs when it finds nothing.
 */

// Anchored, deliberately narrow patterns. A loose pattern is worse than no
// pattern: it produces confident wrong numbers instead of an honest gap.
const PATTERNS = [
    ['net_sales', /^(net_?sales|revenue|revenues|sales_?revenue|operating_?revenue)/i],
    ['operating_income', /^operating_?(income|profit)(loss)?/i],
    ['ordinary_income', /^ordinary_?(income|profit)(loss)?/i],
    ['profit_before_tax', /^(profit|income)_?(loss)?_?before_?(income_?)?tax/i],
    ['profit_loss', /^(profit_?loss|net_?income)(attributabletoownersofparent)?/i],
    ['total_assets', /^(total_?)?assets$/i],
    ['net_assets', /^(total_?)?(net_?assets|equity)$/i],
    ['liabilities', /^(total_?)?liabilities$/i],
    ['cash_and_deposits', /^cash_?and_?(deposits|cash_?equivalents)/i],
    ['research_and_development_expenses', /^research_?and_?development/i],
    [
        'net_cash_provided_by_operating_activities',
        /^net_?cash_?(provided_?by|used_?in)?.*operating_?activities/i,
    ],
];

/** Strips the namespace prefix and any taxonomy-version suffix. */
function localName(elementId) {
    const withoutPrefix = String(elementId).split(':').pop() ?? '';
    return withoutPrefix.replace(/(IFRS|US|JPGAAP)$/i, '');
}

/**
 * Attempts to resolve an element ID by name shape.
 *
 * Returns the canonical field key, or null when nothing matches confidently.
 * Ambiguity resolves to null: if two patterns claim the same element we would be
 * choosing arbitrarily, and a gap is easier to notice than a wrong answer.
 */
export function resolveByPattern(elementId) {
    const name = localName(elementId);
    const matches = PATTERNS.filter(([, pattern]) => pattern.test(name)).map(([field]) => field);

    return matches.length === 1 ? matches[0] : null;
}

export const FALLBACK_FIELDS = PATTERNS.map(([field]) => field);
