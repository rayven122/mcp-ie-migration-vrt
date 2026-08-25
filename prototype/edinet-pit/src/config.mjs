/**
 * The one place that reads process.env.
 *
 * Configuration used to be picked up wherever it was needed, and the flavours had
 * drifted apart: the database path was an environment variable in the MCP server
 * and a flag in the CLI, the lake path was a flag only, and nothing stated which
 * won when both were supplied. Reading the environment in a single module makes
 * that precedence a property of the code rather than something a reader has to
 * reconstruct from four call sites.
 *
 * Secrets are expected to arrive injected rather than from a file:
 *
 *   infisical run --env=dev -- node prototype/edinet-pit/src/cli.mjs backfill ...
 *
 * Deliberately free of node:sqlite so the coverage script, which must run on any
 * supported Node version, can share it.
 */

/** Where each secret comes from, so an error can say more than "it is missing". */
const SECRET_SOURCES = {
    EDINET_API_KEY: 'Issued by EDINET; register at https://api.edinet-fsa.go.jp/',
    GBIZ_API_TOKEN:
        'Issued by the gBizINFO Web API application. Do not use the demo token ' +
        'published on the Swagger page -- it is scoped to that page only.',
};

/**
 * Defaults for a command-line run. They are passed in rather than baked into
 * loadConfig because callers genuinely want different ones: the CLI writes to a
 * file, while the MCP server falls back to an in-memory store seeded from
 * fixtures so it is runnable with nothing configured. What is shared between them
 * is the precedence, not the fallback.
 */
export const CLI_DEFAULTS = {
    db: './edinet-pit.db',
    lake: './edinet-pit-lake',
};

export class MissingSecretError extends Error {
    constructor(name) {
        super(
            [
                `${name} is not set.`,
                SECRET_SOURCES[name] ? `  Source: ${SECRET_SOURCES[name]}` : null,
                '  Provide it with:',
                `    infisical run --env=dev -- <command>`,
                `  or, without Infisical:`,
                `    ${name}=... <command>`,
            ]
                .filter(Boolean)
                .join('\n')
        );
        this.name = 'MissingSecretError';
        // The variable name only. Never the value: this message reaches logs.
        this.variable = name;
    }
}

function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== '');
}

/**
 * Resolves configuration.
 *
 * Precedence is explicit and applies uniformly: a command-line argument beats the
 * environment, which beats the caller's default. Overrides are the parsed CLI
 * flags, so passing undefined for one simply falls through to the next source.
 *
 * @param {object} overrides  Parsed CLI flags (db, lake, ...).
 * @param {object} env        Environment to read; injected in tests.
 * @param {object} defaults   Caller's fallbacks. Omitted keys resolve to undefined.
 */
export function loadConfig(overrides = {}, env = process.env, defaults = CLI_DEFAULTS) {
    return {
        dbPath: firstDefined(overrides.db, env.EDINET_PIT_DB, defaults.db),
        lakePath: firstDefined(overrides.lake, env.EDINET_PIT_LAKE, defaults.lake),

        // Secrets stay undefined when absent rather than throwing here: several
        // commands need no credentials at all, and failing at load time would make
        // the demo and any read-only path require secrets they never use.
        edinetApiKey: firstDefined(overrides.edinetApiKey, env.EDINET_API_KEY),
        gbizApiToken: firstDefined(overrides.gbizApiToken, env.GBIZ_API_TOKEN),
    };
}

/**
 * Returns a secret or throws with instructions.
 *
 * Called at the point of use, so a command that needs no credentials keeps
 * working without them.
 */
export function requireSecret(config, key) {
    const variable = { edinetApiKey: 'EDINET_API_KEY', gbizApiToken: 'GBIZ_API_TOKEN' }[key];
    if (!variable) {
        throw new Error(`unknown secret: ${key}`);
    }
    if (!config[key]) {
        throw new MissingSecretError(variable);
    }
    return config[key];
}

/** Names of every variable this prototype reads, for documentation and tests. */
export const KNOWN_VARIABLES = [
    'EDINET_API_KEY',
    'GBIZ_API_TOKEN',
    'EDINET_PIT_DB',
    'EDINET_PIT_LAKE',
];
