import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    CLI_DEFAULTS,
    KNOWN_VARIABLES,
    loadConfig,
    MissingSecretError,
    requireSecret,
} from '../src/config.mjs';

/** An environment that holds only what a test puts in it. */
const env = (values = {}) => values;

describe('precedence', () => {
    // The rule that did not exist before: the database path was an environment
    // variable in one place and a flag in another, and nothing said which won.
    test('a command-line argument beats the environment', () => {
        const config = loadConfig({ db: 'from-arg.db' }, env({ EDINET_PIT_DB: 'from-env.db' }));
        assert.equal(config.dbPath, 'from-arg.db');
    });

    test('the environment beats the default', () => {
        const config = loadConfig({}, env({ EDINET_PIT_DB: 'from-env.db' }));
        assert.equal(config.dbPath, 'from-env.db');
    });

    test('the default applies when nothing else is given', () => {
        const config = loadConfig({}, env());
        assert.equal(config.dbPath, CLI_DEFAULTS.db);
        assert.equal(config.lakePath, CLI_DEFAULTS.lake);
    });

    test('the same precedence governs the lake path', () => {
        assert.equal(loadConfig({ lake: 'a' }, env({ EDINET_PIT_LAKE: 'b' })).lakePath, 'a');
        assert.equal(loadConfig({}, env({ EDINET_PIT_LAKE: 'b' })).lakePath, 'b');
    });

    // An unset flag must fall through rather than count as a value, or every
    // command that does not accept --db would override the environment with
    // undefined.
    test('an undefined override falls through instead of winning', () => {
        const config = loadConfig({ db: undefined }, env({ EDINET_PIT_DB: 'from-env.db' }));
        assert.equal(config.dbPath, 'from-env.db');
    });

    // An exported-but-empty variable is a common shell accident and means
    // "unset", not "use the empty string as a path".
    test('an empty environment value is treated as unset', () => {
        assert.equal(loadConfig({}, env({ EDINET_PIT_DB: '' })).dbPath, CLI_DEFAULTS.db);
    });

    // The MCP server wants an in-memory store when nothing is configured while the
    // CLI wants a file, so the fallback belongs to the caller.
    test('callers can supply their own defaults', () => {
        const config = loadConfig({}, env(), { db: ':memory:' });
        assert.equal(config.dbPath, ':memory:');
        assert.equal(config.lakePath, undefined, 'an omitted default stays undefined');
    });
});

describe('secrets', () => {
    test('a present secret is returned', () => {
        const config = loadConfig({}, env({ EDINET_API_KEY: 'k' }));
        assert.equal(requireSecret(config, 'edinetApiKey'), 'k');
    });

    // Loading must not throw: demo, report and universe need no credentials, and
    // failing at load time would make them require secrets they never use.
    test('loading without secrets does not throw', () => {
        const config = loadConfig({}, env());
        assert.equal(config.edinetApiKey, undefined);
        assert.equal(config.gbizApiToken, undefined);
    });

    test('requiring an absent secret names the variable and how to supply it', () => {
        const config = loadConfig({}, env());

        assert.throws(
            () => requireSecret(config, 'edinetApiKey'),
            (error) => {
                assert.ok(error instanceof MissingSecretError);
                assert.equal(error.variable, 'EDINET_API_KEY');
                assert.match(error.message, /EDINET_API_KEY is not set/);
                assert.match(error.message, /infisical run/, 'should say how to provide it');
                return true;
            }
        );
    });

    test('the gBizINFO message warns off the published demo token', () => {
        const config = loadConfig({}, env());
        try {
            requireSecret(config, 'gbizApiToken');
            assert.fail('should have thrown');
        } catch (error) {
            assert.match(error.message, /demo token/);
        }
    });

    // This message reaches logs and terminals, so it must carry the variable name
    // and nothing else about the credential.
    test('an error never contains the secret value', () => {
        const config = loadConfig({}, env({ EDINET_API_KEY: 'super-secret-value' }));

        try {
            requireSecret({ ...config, edinetApiKey: undefined }, 'edinetApiKey');
            assert.fail('should have thrown');
        } catch (error) {
            assert.ok(!error.message.includes('super-secret-value'));
            assert.ok(!JSON.stringify(error.variable).includes('super-secret-value'));
        }
    });

    test('an unknown secret key is a programming error', () => {
        assert.throws(() => requireSecret({}, 'nonsense'), /unknown secret/);
    });
});

describe('documented surface', () => {
    // .env.example and the Infisical project are kept in step with this list, so
    // adding a variable without listing it should be visible.
    test('every variable the prototype reads is named', () => {
        assert.deepEqual(KNOWN_VARIABLES, [
            'EDINET_API_KEY',
            'GBIZ_API_TOKEN',
            'EDINET_PIT_DB',
            'EDINET_PIT_LAKE',
        ]);
    });
});
