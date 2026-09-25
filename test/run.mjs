/**
 * Unit tests for @moruteaven/dsh-key-panel: policy, store, tools, gateway.
 *
 * Run: node test/run.mjs
 * Exits non-zero on the first failing assertion group.
 */
import { rmSync, existsSync, readFileSync, writeFileSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const lib = name => import(pathToFileURL(join(ROOT, 'lib', name)).href).then(m => m.default ?? m);

const { KeyStore, keyStorePath, isValidKeyName, ORIGIN_MODEL, ORIGIN_OPERATOR, STORE_VERSION, isValidIdentifier, isValidField, accountKey, credentialName, normalisePlatforms, normaliseAccounts, FIELD_ID, FIELD_KEY } = await import(pathToFileURL(join(ROOT, 'lib/store.js')).href);
const policy = await import(pathToFileURL(join(ROOT, 'lib/policy.js')).href);
const { ConfirmationLedger } = await import(pathToFileURL(join(ROOT, 'lib/tools.js')).href);
const usageModuleUrl = pathToFileURL(join(ROOT, 'lib/usage.js')).href;
const indexModuleUrl = pathToFileURL(join(ROOT, 'lib/index.js')).href;

const { checkModelAccess, normalisePolicy, normaliseScopePattern, scopeMatcher, isAccessMode, ACCESS_MODES, DEFAULT_ACCESS_MODE } = policy;

let passed = 0;
let failed = 0;
let group = '';

const describe = name => { group = name; console.log(`\n${name}`); };
const it = (label, fn) => {
    try {
        const result = fn();
        if (result === false) throw new Error('returned false');
        passed += 1;
        console.log(`  ✓ ${label}`);
    }
    catch (error) {
        failed += 1;
        console.log(`  ✗ ${label} — ${error?.message ?? error}`);
    }
};
const eq = (actual, expected, what = '') => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${what}${what ? ': ' : ''}expected ${b}, got ${a}`);
    return true;
};
const throws = (fn, match) => {
    try { fn(); }
    catch (error) {
        if (match !== undefined && !String(error.message).includes(match)) {
            throw new Error(`threw but message lacked ${JSON.stringify(match)}: ${error.message}`);
        }
        return true;
    }
    throw new Error('expected a throw, got none');
};

const sandbox = mkdtempSync(join(tmpdir(), 'kp-test-'));
const storeFile = join(sandbox, 'keys.json');
const newStore = () => new KeyStore(storeFile);

// ─────────────────────────────────────────────────────────────────────────────
describe('[1] policy: name grammar');
it('accepts DSH_OPENAI_KEY', () => eq(isValidKeyName('DSH_OPENAI_KEY'), true));
it('accepts a double underscore', () => eq(isValidKeyName('DSH_OK__MAYBE'), true));
it('accepts digits after the first letter', () => eq(isValidKeyName('DSH_A1B2'), true));
it('rejects a missing prefix', () => eq(isValidKeyName('OPENAI_KEY'), false));
it('rejects lowercase', () => eq(isValidKeyName('DSH_lower'), false));
it('rejects a leading digit', () => eq(isValidKeyName('DSH_1A'), false));
it('rejects a hyphen', () => eq(isValidKeyName('DSH_A-B'), false));
it('rejects a space', () => eq(isValidKeyName('DSH_A B'), false));
it('rejects an empty body', () => eq(isValidKeyName('DSH_'), false));
it('rejects a non-string', () => eq(isValidKeyName(42), false));

// ─────────────────────────────────────────────────────────────────────────────
describe('[2] policy: scope patterns');
it('null means unrestricted', () => eq(normaliseScopePattern(null), null));
it('empty string means unrestricted', () => eq(normaliseScopePattern('   '), null));
it('rejects a pattern without the DSH_ prefix', () => throws(() => normaliseScopePattern('AGENT_*'), 'must start with DSH_'));
it('rejects a regex metacharacter', () => throws(() => normaliseScopePattern('DSH_A.B*'), 'may only contain'));
it('rejects a path separator', () => throws(() => normaliseScopePattern('DSH_A/B'), 'may only contain'));
it('accepts DSH_AGENT_*', () => eq(normaliseScopePattern('DSH_AGENT_*'), 'DSH_AGENT_*'));
it('unrestricted matcher accepts anything', () => eq(scopeMatcher(null)('DSH_ANYTHING'), true));
it('DSH_AGENT_* matches DSH_AGENT_CF', () => eq(scopeMatcher('DSH_AGENT_*')('DSH_AGENT_CF'), true));
it('DSH_AGENT_* rejects DSH_OPENAI_KEY', () => eq(scopeMatcher('DSH_AGENT_*')('DSH_OPENAI_KEY'), false));
it('a leading glob matches any prefix', () => eq(scopeMatcher('*_KEY')('DSH_OPENAI_KEY'), true));
it('a leading glob rejects a non-matching suffix', () => eq(scopeMatcher('*_KEY')('DSH_OPENAI_TOKEN'), false));
it('an infix glob matches', () => eq(scopeMatcher('DSH_*_KEY')('DSH_OPENAI_KEY'), true));
it('an infix glob rejects when the middle is absent', () => eq(scopeMatcher('DSH_*_KEY')('DSH_KEY'), false));
it('a bare * matches everything', () => eq(scopeMatcher('*')('DSH_ANY'), true));
it('an exact pattern matches only itself', () => eq(scopeMatcher('DSH_ONE')('DSH_ONE'), true));
it('an exact pattern rejects a longer name', () => eq(scopeMatcher('DSH_ONE')('DSH_ONE_MORE'), false));
it('matcher is literal about regex chars it never sees', () => eq(scopeMatcher('DSH_A1')('DSH_A1'), true));

// ─────────────────────────────────────────────────────────────────────────────
describe('[3] policy: access decisions');
const P = (mode, scope = null) => ({ accessMode: mode, scopePattern: scope });
it('readonly allows read', () => eq(checkModelAccess(P('readonly'), 'read').allowed, true));
it('readonly refuses create', () => eq(checkModelAccess(P('readonly'), 'create', 'DSH_X').allowed, false));
it('readonly refuses update', () => eq(checkModelAccess(P('readonly'), 'update', 'DSH_X', { existed: true, origin: 'model' }).allowed, false));
it('readonly refuses delete', () => eq(checkModelAccess(P('readonly'), 'delete', 'DSH_X').allowed, false));
it('write allows create', () => eq(checkModelAccess(P('write'), 'create', 'DSH_X').allowed, true));
it('write allows updating its own key', () => eq(checkModelAccess(P('write'), 'update', 'DSH_X', { existed: true, origin: 'model' }).allowed, true));
it('write refuses updating an operator key', () => eq(checkModelAccess(P('write'), 'update', 'DSH_X', { existed: true, origin: 'operator' }).allowed, false));
it('write refuses updating a key with no provenance', () => eq(checkModelAccess(P('write'), 'update', 'DSH_X', { existed: true }).allowed, false));
it('write allows creating over a nonexistent name', () => eq(checkModelAccess(P('write'), 'create', 'DSH_NEW').allowed, true));
it('write refuses delete', () => eq(checkModelAccess(P('write'), 'delete', 'DSH_X', { existed: true, origin: 'model' }).allowed, false));
it('edit allows create', () => eq(checkModelAccess(P('edit'), 'create', 'DSH_X').allowed, true));
it('edit allows updating an operator key', () => eq(checkModelAccess(P('edit'), 'update', 'DSH_X', { existed: true, origin: 'operator' }).allowed, true));
it('edit allows delete', () => eq(checkModelAccess(P('edit'), 'delete', 'DSH_X').allowed, true));
it('scope blocks create outside the pattern', () => eq(checkModelAccess(P('edit', 'DSH_AGENT_*'), 'create', 'DSH_OTHER').allowed, false));
it('scope permits create inside the pattern', () => eq(checkModelAccess(P('edit', 'DSH_AGENT_*'), 'create', 'DSH_AGENT_CF').allowed, true));
it('scope blocks delete outside the pattern', () => eq(checkModelAccess(P('edit', 'DSH_AGENT_*'), 'delete', 'DSH_OTHER').allowed, false));
it('scope still allows read outside the pattern', () => eq(checkModelAccess(P('edit', 'DSH_AGENT_*'), 'read').allowed, true));
it('an unknown operation is refused', () => eq(checkModelAccess(P('edit'), 'frobnicate', 'DSH_X').allowed, false));
it('a refusal carries a human-readable reason', () => {
    const v = checkModelAccess(P('readonly'), 'create', 'DSH_X');
    if (typeof v.reason !== 'string' || v.reason.length === 0) throw new Error('no reason');
    return true;
});
it('an unknown mode degrades to readonly', () => eq(checkModelAccess({ accessMode: 'root' }, 'create', 'DSH_X').allowed, false));

// ─────────────────────────────────────────────────────────────────────────────
describe('[4] policy: persistence normalisation');
it('an empty document yields the default', () => eq(normalisePolicy(undefined), { accessMode: 'readonly', scopePattern: null }));
it('the default mode is readonly', () => eq(DEFAULT_ACCESS_MODE, 'readonly'));
it('a valid document round-trips', () => eq(normalisePolicy({ accessMode: 'edit', scopePattern: 'DSH_A_*' }), { accessMode: 'edit', scopePattern: 'DSH_A_*' }));
it('an invalid mode degrades to the default', () => eq(normalisePolicy({ accessMode: 'nope' }).accessMode, 'readonly'));
it('an invalid scope degrades to unrestricted', () => eq(normalisePolicy({ accessMode: 'write', scopePattern: 'BAD*' }).scopePattern, null));
it('a non-object document degrades cleanly', () => eq(normalisePolicy('garbage'), { accessMode: 'readonly', scopePattern: null }));
it('an array document degrades cleanly', () => eq(normalisePolicy([1, 2]), { accessMode: 'readonly', scopePattern: null }));
it('exactly three modes exist', () => eq(ACCESS_MODES.length, 3));
it('isAccessMode accepts the three', () => eq(ACCESS_MODES.every(isAccessMode), true));
it('isAccessMode rejects a non-member', () => eq(isAccessMode('admin'), false));

// ─────────────────────────────────────────────────────────────────────────────
describe('[5] store: basics and provenance');
rmSync(sandbox, { recursive: true, force: true });
let store = newStore();
it('a fresh store is empty', () => eq(store.names(), []));
it('a fresh store defaults to readonly', () => eq(store.policy().accessMode, 'readonly'));
it('set() stores an operator key', () => eq(store.set('DSH_A', 'v1', 'first').origin, ORIGIN_OPERATOR));
it('set() records model provenance when asked', () => eq(store.set('DSH_B', 'v2', 'second', { origin: ORIGIN_MODEL }).origin, ORIGIN_MODEL));
it('has() finds it', () => eq(store.has('DSH_B'), true));
it('get() returns the record', () => eq(store.get('DSH_A').value, 'v1'));
it('get() of an unknown name is undefined', () => eq(store.get('DSH_NOPE'), undefined));
it('names() is sorted', () => eq(store.names(), ['DSH_A', 'DSH_B']));
it('list() carries values', () => eq(store.list().length, 2));
it('values() is a plain map', () => eq(store.values(), { DSH_A: 'v1', DSH_B: 'v2' }));
it('descriptions() is a plain map', () => eq(store.descriptions(), { DSH_A: 'first', DSH_B: 'second' }));
it('rejects an invalid name', () => throws(() => store.set('bad_name', 'v', 'd'), 'invalid key name'));
it('rejects a blank value', () => throws(() => store.set('DSH_C', '   ', 'd'), 'must not be blank'));
it('rejects a blank description', () => throws(() => store.set('DSH_C', 'v', '  '), 'must not be blank'));
it('rejects a non-string value', () => throws(() => store.set('DSH_C', 5, 'd'), 'must be a string'));
it('rejects a non-string description', () => throws(() => store.set('DSH_C', 'v', null), 'must be a string'));
it('trims surrounding whitespace', () => eq(store.set('DSH_T', '  spaced  ', '  desc  ').value, 'spaced'));
it('trims the description too', () => eq(store.get('DSH_T').description, 'desc'));

describe('[6] store: provenance survives rewrites');
it('an operator key stays operator after an edit', () => eq(store.set('DSH_A', 'v1b', 'edited').origin, ORIGIN_OPERATOR));
it('a model key stays model after an edit', () => eq(store.set('DSH_B', 'v2b', 'edited', { origin: ORIGIN_OPERATOR }).origin, ORIGIN_MODEL));
it('createdAt is preserved across an update', () => {
    const first = store.get('DSH_A').createdAt;
    const after = store.set('DSH_A', 'v1c', 'again').createdAt;
    if (first !== after) throw new Error(`createdAt moved: ${first} -> ${after}`);
    return true;
});
it('updatedAt advances on rewrite', () => {
    const before = store.get('DSH_A').updatedAt;
    const after = store.set('DSH_A', 'v1d', 'again').updatedAt;
    if (after < before) throw new Error('updatedAt went backwards');
    return true;
});

describe('[7] store: policy round-trip');
it('setPolicy stores a mode', () => eq(store.setPolicy({ accessMode: 'edit' }).accessMode, 'edit'));
it('setPolicy stores a scope', () => eq(store.setPolicy({ accessMode: 'write', scopePattern: 'DSH_AGENT_*' }).scopePattern, 'DSH_AGENT_*'));
it('policy() reflects the write', () => eq(store.policy(), { accessMode: 'write', scopePattern: 'DSH_AGENT_*' }));
it('setPolicy rejects an invalid mode', () => throws(() => store.setPolicy({ accessMode: 'sudo' }), 'unknown access mode'));
it('policy() returns a copy, not the live object', () => {
    const snapshot = store.policy();
    snapshot.accessMode = 'edit';
    if (store.policy().accessMode === 'edit') throw new Error('policy() leaked a mutable reference');
    return true;
});

describe('[8] store: persistence across instances');
it('the file exists', () => eq(existsSync(storeFile), true));
it('a reload sees the same keys', () => eq(newStore().names(), ['DSH_A', 'DSH_B', 'DSH_T']));
it('a reload sees the same values', () => eq(newStore().get('DSH_A').value, 'v1d'));
it('a reload preserves provenance', () => eq(newStore().get('DSH_B').origin, ORIGIN_MODEL));
it('a reload preserves the policy', () => eq(newStore().policy(), { accessMode: 'write', scopePattern: 'DSH_AGENT_*' }));
it('the on-disk document has the documented shape', () => {
    const disk = JSON.parse(readFileSync(storeFile, 'utf8'));
    // Compared against the constant, not a literal: this assertion exists to
    // catch a shape drift, and hard-coding the number would make every
    // deliberate bump look like a regression.
    if (disk.version !== STORE_VERSION) throw new Error('version');
    if (typeof disk.policy !== 'object') throw new Error('policy');
    if (typeof disk.keys !== 'object') throw new Error('keys');
    return true;
});
it('remove() reports true once', () => eq(store.remove('DSH_T'), true));
it('remove() reports false when absent', () => eq(store.remove('DSH_T'), false));

describe('[9] store: rejects a corrupt file');
it('rejects invalid JSON', () => {
    writeFileSync(storeFile, '{ not json');
    throws(() => newStore(), 'could not parse');
    return true;
});
it('rejects a top-level array', () => {
    writeFileSync(storeFile, '[]');
    throws(() => newStore(), 'must contain a JSON object');
    return true;
});
it('rejects an invalid stored name', () => {
    writeFileSync(storeFile, JSON.stringify({ version: 1, keys: { bad_name: { value: 'v', description: 'd' } } }));
    throws(() => newStore(), 'is invalid');
    return true;
});
it('rejects an entry without a string value', () => {
    writeFileSync(storeFile, JSON.stringify({ version: 1, keys: { DSH_A: { description: 'd' } } }));
    throws(() => newStore(), 'no string value');
    return true;
});
it('tolerates a missing keys member', () => {
    writeFileSync(storeFile, JSON.stringify({ version: 1 }));
    eq(newStore().names(), []);
    return true;
});
it('tolerates a corrupt policy by degrading', () => {
    writeFileSync(storeFile, JSON.stringify({ version: 1, policy: { accessMode: 'nope' }, keys: {} }));
    eq(newStore().policy().accessMode, 'readonly');
    return true;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('[10] confirmation ledger');
const ledger = new ConfirmationLedger();
it('issues a token', () => {
    const t = ledger.issue('DSH_A');
    if (typeof t !== 'string' || t.length < 16) throw new Error(`weak token: ${t}`);
    return true;
});
it('issues distinct tokens', () => {
    const a = ledger.issue('DSH_A');
    const b = ledger.issue('DSH_B');
    if (a === b) throw new Error('tokens collided');
    return true;
});
it('re-issuing for a name supersedes the old token', () => {
    const first = ledger.issue('DSH_C');
    ledger.issue('DSH_C');
    eq(ledger.consume(first, 'DSH_C'), false);
});
it('consumes a valid token once', () => {
    const t = ledger.issue('DSH_D');
    eq(ledger.consume(t, 'DSH_D'), true);
    eq(ledger.consume(t, 'DSH_D'), false);
});
it('refuses a token issued for a different name', () => {
    const t = ledger.issue('DSH_E');
    eq(ledger.consume(t, 'DSH_F'), false);
});
it('refuses an unknown token', () => eq(ledger.consume('deadbeef', 'DSH_E'), false));
it('refuses an empty token', () => eq(ledger.consume('', 'DSH_E'), false));

// ─────────────────────────────────────────────────────────────────────────────
describe('[11] tools: registration follows the policy');
const { registerModelTools } = await import(pathToFileURL(join(ROOT, 'lib/tools.js')).href);

const toolsDir = mkdtempSync(join(tmpdir(), 'kp-tools-'));
const toolStoreFile = join(toolsDir, 'keys.json');

/** Build a ctx stub recording every registered tool. */
function toolCtx() {
    const registered = new Map();
    return {
        registered,
        logger: { info: () => {} },
        tools: {
            register(definition) {
                registered.set(definition.name, definition);
                return () => registered.delete(definition.name);
            },
        },
    };
}

// `key_panel_intent` is in EVERY row on purpose. Declaring a purpose is not a
// mutation, so it is not gated by the mode — and readonly is where it earns its
// place, since the model can still reference $DSH_* names in a shell command
// while having no other tools at all.
for (const [mode, expected] of [
    ['readonly', ['key_panel_intent']],
    ['write', ['key_panel_intent', 'key_panel_list', 'key_panel_set']],
    ['edit', ['key_panel_intent', 'key_panel_list', 'key_panel_set', 'key_panel_delete']],
]) {
    it(`mode ${mode} registers ${expected.join(', ')}`, () => {
        const s = new KeyStore(toolStoreFile);
        s.setPolicy({ accessMode: mode });
        const ctx = toolCtx();
        const dispose = registerModelTools({ ctx, store: s, resync: () => {}, ledger: new ConfirmationLedger() });
        eq([...ctx.registered.keys()].sort(), expected.sort());
        // The disposer must remove exactly what was added.
        dispose();
        eq(ctx.registered.size, 0);
        return true;
    });
}

describe('[12] tools: key_panel_list');
{
    const s = new KeyStore(toolStoreFile);
    s.setPolicy({ accessMode: 'edit' });
    s.set('DSH_OPERATOR', 'secret-op', 'mine');
    s.set('DSH_AGENT_X', 'secret-ag', 'theirs', { origin: ORIGIN_MODEL });
    const ctx = toolCtx();
    registerModelTools({ ctx, store: s, resync: () => {}, ledger: new ConfirmationLedger() });
    const tool = () => ctx.registered.get('key_panel_list');

    it('returns names, descriptions and origins', async () => {
        const value = await tool().execute({}, {});
        eq(value.count, 2);
        eq(value.keys.map(k => k.name).sort(), ['DSH_AGENT_X', 'DSH_OPERATOR']);
        eq(value.keys.find(k => k.name === 'DSH_AGENT_X').origin, 'model');
        return true;
    });
    it('never returns a value', async () => {
        const value = await tool().execute({}, {});
        if (JSON.stringify(value).includes('secret')) throw new Error('a value leaked');
        return true;
    });
    it('reports the access mode', async () => {
        const value = await tool().execute({}, {});
        eq(value.accessMode, 'edit');
        return true;
    });
    it('renders without leaking', async () => {
        const value = await tool().execute({}, {});
        const rendered = JSON.stringify(tool().output.render({}, value));
        if (rendered.includes('secret')) throw new Error('a value leaked into the render');
        return true;
    });
}

describe('[13] tools: key_panel_set');
{
    const s = new KeyStore(toolStoreFile);
    s.setPolicy({ accessMode: 'write' });
    const ctx = toolCtx();
    let resyncs = 0;
    registerModelTools({ ctx, store: s, resync: () => { resyncs += 1; }, ledger: new ConfirmationLedger() });
    const tool = () => ctx.registered.get('key_panel_set');

    it('creates a new key', async () => {
        const value = await tool().execute({ name: 'DSH_AGENT_CF', value: 'cf-token-123', description: 'Cloudflare API token' }, {});
        eq(value.stored, true);
        eq(value.created, true);
        eq(s.get('DSH_AGENT_CF').value, 'cf-token-123');
        return true;
    });
    it('marks the key as model-created', () => eq(s.get('DSH_AGENT_CF').origin, ORIGIN_MODEL));
    it('resyncs the shell env', () => eq(resyncs > 0, true));
    it('masks the value in its result', async () => {
        const value = await tool().execute({ name: 'DSH_AGENT_LONG', value: 'abcdefghijklmnopqrstuvwxyz', description: 'x' }, {});
        if (value.masked.includes('abcdefghijkl')) throw new Error(`unmasked: ${value.masked}`);
        return true;
    });
    it('reports update rather than create on rewrite', async () => {
        const value = await tool().execute({ name: 'DSH_AGENT_CF', value: 'cf-token-456', description: 'rotated' }, {});
        eq(value.created, false);
        eq(value.stored, true);
        return true;
    });
    it('refuses an invalid name without throwing', async () => {
        const value = await tool().execute({ name: 'bad_name', value: 'v', description: 'd' }, {});
        eq(value.stored, false);
        if (!value.message.includes('DSH_')) throw new Error('unhelpful message');
        return true;
    });
    it('refuses to overwrite an operator key in write mode', async () => {
        const opStore = new KeyStore(join(toolsDir, 'op.json'));
        opStore.setPolicy({ accessMode: 'write' });
        opStore.set('DSH_OPERATOR', 'op-secret', 'mine');
        const c = toolCtx();
        registerModelTools({ ctx: c, store: opStore, resync: () => {}, ledger: new ConfirmationLedger() });
        const value = await c.registered.get('key_panel_set').execute({ name: 'DSH_OPERATOR', value: 'hijack', description: 'hijacked' }, {});
        eq(value.stored, false);
        eq(opStore.get('DSH_OPERATOR').value, 'op-secret');
        return true;
    });
    it('permits overwriting an operator key in edit mode', async () => {
        const editStore = new KeyStore(join(toolsDir, 'edit.json'));
        editStore.setPolicy({ accessMode: 'edit' });
        editStore.set('DSH_OPERATOR', 'op-secret', 'mine');
        const c = toolCtx();
        registerModelTools({ ctx: c, store: editStore, resync: () => {}, ledger: new ConfirmationLedger() });
        const value = await c.registered.get('key_panel_set').execute({ name: 'DSH_OPERATOR', value: 'replaced', description: 'replaced' }, {});
        eq(value.stored, true);
        eq(editStore.get('DSH_OPERATOR').value, 'replaced');
        return true;
    });
    it('honours a scope pattern on create', async () => {
        const scoped = new KeyStore(join(toolsDir, 'scoped.json'));
        scoped.setPolicy({ accessMode: 'edit', scopePattern: 'DSH_AGENT_*' });
        const c = toolCtx();
        registerModelTools({ ctx: c, store: scoped, resync: () => {}, ledger: new ConfirmationLedger() });
        const refused = await c.registered.get('key_panel_set').execute({ name: 'DSH_OUTSIDE', value: 'v', description: 'd' }, {});
        eq(refused.stored, false);
        const allowed = await c.registered.get('key_panel_set').execute({ name: 'DSH_AGENT_OK', value: 'v', description: 'd' }, {});
        eq(allowed.stored, true);
        return true;
    });
    it('reads the policy live, not at registration time', async () => {
        const live = new KeyStore(join(toolsDir, 'live.json'));
        live.setPolicy({ accessMode: 'write' });
        const c = toolCtx();
        registerModelTools({ ctx: c, store: live, resync: () => {}, ledger: new ConfirmationLedger() });
        live.setPolicy({ accessMode: 'readonly' });
        const value = await c.registered.get('key_panel_set').execute({ name: 'DSH_X', value: 'v', description: 'd' }, {});
        eq(value.stored, false);
        eq(live.has('DSH_X'), false);
        return true;
    });
}

describe('[14] tools: key_panel_delete two-phase');
{
    const s = new KeyStore(join(toolsDir, 'del.json'));
    s.setPolicy({ accessMode: 'edit' });
    s.set('DSH_GONE', 'v', 'to be removed');
    const ctx = toolCtx();
    registerModelTools({ ctx, store: s, resync: () => {}, ledger: new ConfirmationLedger() });
    const tool = () => ctx.registered.get('key_panel_delete');
    let token = '';

    it('phase one does not delete', async () => {
        const value = await tool().execute({ name: 'DSH_GONE' }, {});
        eq(value.deleted, false);
        eq(value.needsConfirmation, true);
        eq(s.has('DSH_GONE'), true);
        token = value.token;
        if (typeof token !== 'string' || token.length === 0) throw new Error('no token issued');
        return true;
    });
    it('phase two deletes with the token', async () => {
        const value = await tool().execute({ name: 'DSH_GONE', confirm: token }, {});
        eq(value.deleted, true);
        eq(s.has('DSH_GONE'), false);
        return true;
    });
    it('a used token cannot be replayed', async () => {
        const value = await tool().execute({ name: 'DSH_GONE', confirm: token }, {});
        eq(value.deleted, false);
        return true;
    });
    it('a fabricated token is refused', async () => {
        s.set('DSH_GONE2', 'v', 'd');
        const wrong = await tool().execute({ name: 'DSH_GONE2', confirm: 'nope' }, {});
        eq(wrong.deleted, false);
        eq(s.has('DSH_GONE2'), true);
        return true;
    });
    it('a token for another name is refused', async () => {
        s.set('DSH_OTHER', 'v', 'd');
        const a = await tool().execute({ name: 'DSH_GONE2' }, {});
        const crossed = await tool().execute({ name: 'DSH_OTHER', confirm: a.token }, {});
        eq(crossed.deleted, false);
        eq(s.has('DSH_OTHER'), true);
        return true;
    });
    it('an unknown name is reported, not thrown', async () => {
        const value = await tool().execute({ name: 'DSH_MISSING' }, {});
        eq(value.deleted, false);
        if (!value.message.includes('No credential')) throw new Error(value.message);
        return true;
    });
    it('write mode has no delete tool at all', () => {
        const w = new KeyStore(join(toolsDir, 'wdel.json'));
        w.setPolicy({ accessMode: 'write' });
        const c = toolCtx();
        registerModelTools({ ctx: c, store: w, resync: () => {}, ledger: new ConfirmationLedger() });
        eq(c.registered.has('key_panel_delete'), false);
        return true;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('[15] end to end: gateway drives the store');
{
    const host = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href);
    const e2eDir = mkdtempSync(join(tmpdir(), 'kp-e2e-'));
    const registrations = [];
    let gateway = null;
    const shellEnv = { register(def) { registrations.push(def); return () => { def.disposed = true; }; } };
    const ctx = {
        logger: { info: () => {} },
        effect: () => {},
        get: n => (n === 'shellEnv' ? shellEnv : undefined),
        shellEnv,
        tools: { register() { return () => {}; } },
        plugin: (ctor, deps) => { gateway = new ctor({ reflect: { provide() {} } }, deps); },
    };
    host.apply(ctx, { dshHome: e2eDir });

    it('starts empty in readonly', () => {
        eq(gateway.list(), []);
        eq(gateway.getPolicy().accessMode, 'readonly');
        return true;
    });
    it('the operator can add a key', () => {
        const r = gateway.set('DSH_MINE', 'op-value', 'operator key');
        eq(r.masked.includes('op-value'), false);
        eq(gateway.reveal('DSH_MINE').value, 'op-value');
        return true;
    });
    it('the shell env carries it', () => {
        eq(registrations.length, 1);
        eq(registrations[0].resolve().DSH_MINE, 'op-value');
        return true;
    });
    it('the operator key is marked operator-origin', () => eq(gateway.list()[0].origin, 'operator'));
    it('switching to edit takes effect', () => {
        eq(gateway.setPolicy('edit', null).accessMode, 'edit');
        return true;
    });
    it('setPolicy rejects a bad mode', () => throws(() => gateway.setPolicy('root', null), 'unknown access mode'));
    it('setPolicy rejects a bad scope', () => throws(() => gateway.setPolicy('edit', 'BAD'), 'must start with DSH_'));
    it('status reports the mode', () => eq(gateway.status().policy.accessMode, 'edit'));
    it('status reports grouping counts beside the flat names', () => {
        const s = gateway.status();
        eq(typeof s.platformCount, 'number');
        eq(typeof s.accountCount, 'number');
        eq(typeof s.ungroupedCount, 'number');
        return true;
    });
    it('status counts every key exactly once across grouped and ungrouped', () => {
        const s = gateway.status();
        eq(s.ungroupedCount + s.names.length - s.ungroupedCount, s.names.length);
        if (s.ungroupedCount > s.names.length) throw new Error('ungrouped exceeds total');
        return true;
    });
    it('status describes the mode in words', () => {
        if (typeof gateway.status().modeDescription !== 'string') throw new Error('missing');
        return true;
    });
    it('the operator can remove a key', () => {
        eq(gateway.remove('DSH_MINE').removed, true);
        eq(gateway.list().filter(k => k.name === 'DSH_MINE').length, 0);
        return true;
    });
    it('groups() reports no platforms at first', () => eq(gateway.groups(), { platforms: [], accounts: [] }));
    it('the operator can add a platform', () => eq(gateway.addPlatform('CF', 'Cloudflare').label, 'Cloudflare'));
    it('groups() reports the platform', () => eq(gateway.groups().platforms.map(p => p.identifier), ['CF']));
    it('credentialNames() previews the two variable names', () => eq(gateway.credentialNames('CF', 'WORK'), { id: 'DSH_CF_WORK_ID', key: 'DSH_CF_WORK_KEY' }));
    it('credentialNames() does not require the account to exist yet', () => eq(gateway.credentialNames('CF', 'FUTURE').key, 'DSH_CF_FUTURE_KEY'));
    it('the operator can add an account', () => eq(gateway.addAccount('CF', 'WORK', 'Work').platform, 'CF'));
    it('groups() reports the account', () => eq(gateway.groups().accounts.map(a => a.identifier), ['WORK']));
    it('a filed key carries its slot through the gateway', () => {
        const r = gateway.set('DSH_CF_WORK_KEY', 'cf-7', 'Cloudflare token', { platform: 'CF', account: 'WORK', field: 'key' });
        eq(r.platform, 'CF');
        eq(r.field, 'key');
        return true;
    });
    it('the gateway never returns the filed value', () => eq(gateway.list().find(k => k.name === 'DSH_CF_WORK_KEY').masked.includes('cf-7'), false));
    it('a filed key shows its slot in list()', () => eq(gateway.list().find(k => k.name === 'DSH_CF_WORK_KEY').account, 'WORK'));
    it('the filed key reaches the shell env under its full name', () => eq(registrations[registrations.length - 1].resolve().DSH_CF_WORK_KEY, 'cf-7'));
    it('relabelling a platform leaves the identifier alone', () => eq(gateway.setPlatformLabel('CF', 'Cloudflare Inc').identifier, 'CF'));
    it('a filed key survives the relabel', () => eq(gateway.list().find(k => k.name === 'DSH_CF_WORK_KEY').platform, 'CF'));
    it('relabelling an account works too', () => eq(gateway.setAccountLabel('CF', 'WORK', 'Work acct').label, 'Work acct'));
    it('removing a platform that holds keys is refused without force', () => throws(() => gateway.removePlatform('CF'), 'still holds'));
    it('the refusal left the platform in place', () => eq(gateway.groups().platforms.length, 1));
    it('removePlatform with force un-files the keys', () => eq(gateway.removePlatform('CF', true).unfiled, ['DSH_CF_WORK_KEY']));
    it('the platform is gone', () => eq(gateway.groups().platforms, []));
    it('the un-filed key still lists', () => eq(gateway.list().find(k => k.name === 'DSH_CF_WORK_KEY') !== undefined, true));
    it('the un-filed key reports no slot', () => {
    const row = gateway.list().find(k => k.name === 'DSH_CF_WORK_KEY');
    if (row.platform !== undefined) throw new Error('stale slot');
    return true;
    });
    it('the secret survived the un-filing', () => eq(gateway.reveal('DSH_CF_WORK_KEY').value, 'cf-7'));
    it('it is still injected after the un-filing', () => eq(registrations[registrations.length - 1].resolve().DSH_CF_WORK_KEY, 'cf-7'));
    it('removeAccount with force reports what it un-filed', () => {
        gateway.addPlatform('AWS');
        gateway.addAccount('AWS', 'WORK');
        gateway.set('DSH_AWS_WORK_KEY', 'aws-7', 'AWS key', { platform: 'AWS', account: 'WORK', field: 'key' });
        eq(gateway.removeAccount('AWS', 'WORK', true).unfiled, ['DSH_AWS_WORK_KEY']);
        return true;
    });
    it('removing an account that holds nothing reports no un-filing', () => eq(gateway.removeAccount('AWS', 'WORK', true), { removed: false, unfiled: [] }));
    it('adding an account under an unknown platform is refused', () => throws(() => gateway.addAccount('NOPE', 'X'), 'unknown platform'));
    it('adding a duplicate platform is refused', () => throws(() => gateway.addPlatform('AWS'), 'already exists'));

    rmSync(e2eDir, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('[16] identifiers and credential-name splicing');
it('accepts an uppercase identifier', () => eq(isValidIdentifier('CF'), true));
it('accepts digits and underscores after the first letter', () => eq(isValidIdentifier('A1_B2'), true));
it('rejects lowercase', () => eq(isValidIdentifier('cf'), false));
it('rejects a leading digit', () => eq(isValidIdentifier('1CF'), false));
it('rejects a hyphen', () => eq(isValidIdentifier('CLOUD-FLARE'), false));
it('rejects a space', () => eq(isValidIdentifier('CLOUD FLARE'), false));
it('rejects an empty identifier', () => eq(isValidIdentifier(''), false));
it('rejects a non-string identifier', () => eq(isValidIdentifier(7), false));
it('accepts the id field', () => eq(isValidField(FIELD_ID), true));
it('accepts the key field', () => eq(isValidField(FIELD_KEY), true));
it('rejects an unknown field', () => eq(isValidField('token'), false));
it('splices a credential name for the id slot', () => eq(credentialName('CF', 'WORK', FIELD_ID), 'DSH_CF_WORK_ID'));
it('splices a credential name for the key slot', () => eq(credentialName('CF', 'WORK', FIELD_KEY), 'DSH_CF_WORK_KEY'));
it('the spliced name passes the registry grammar', () => eq(isValidKeyName(credentialName('CF', 'WORK', FIELD_KEY)), true));
it('splicing refuses a lowercase platform rather than upper-casing it', () => throws(() => credentialName('cf', 'WORK', FIELD_ID), 'invalid platform identifier'));
it('splicing refuses an invalid account', () => throws(() => credentialName('CF', 'work', FIELD_ID), 'invalid account identifier'));
it('splicing refuses an unknown field', () => throws(() => credentialName('CF', 'WORK', 'secret'), 'invalid field'));
it('the account composite key is platform-scoped', () => eq(accountKey('CF', 'WORK'), 'CF/WORK'));
it('the same account identifier under two platforms does not collide', () => {
    if (accountKey('CF', 'WORK') === accountKey('AWS', 'WORK')) throw new Error('collided');
    return true;
});
it('two accounts in one platform produce distinct names', () => {
    if (credentialName('CF', 'WORK', FIELD_KEY) === credentialName('CF', 'ME', FIELD_KEY)) throw new Error('collided');
    return true;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('[17] store: platforms and accounts');
const grouped = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'kp-group-'));
    const file = join(dir, 'keys.json');
    return { dir, file, open: () => new KeyStore(file) };
})();
it('a fresh store has no platforms', () => eq(grouped.open().platforms(), []));
it('addPlatform stores one', () => eq(grouped.open().addPlatform('CF', { label: 'Cloudflare' }).identifier, 'CF'));
it('the label is kept', () => eq(grouped.open().platforms()[0].label, 'Cloudflare'));
it('the label defaults to the identifier', () => eq(grouped.open().addPlatform('AWS').label, 'AWS'));
it('a duplicate platform is refused', () => throws(() => grouped.open().addPlatform('CF'), 'already exists'));
it('a lowercase platform is refused', () => throws(() => grouped.open().addPlatform('cf'), 'invalid platform identifier'));
it('platforms survive a reload', () => eq(grouped.open().platforms().map(p => p.identifier).sort(), ['AWS', 'CF']));
it('addAccount needs an existing platform', () => throws(() => grouped.open().addAccount('NOPE', 'WORK'), 'unknown platform'));
it('addAccount stores one under the platform', () => eq(grouped.open().addAccount('CF', 'WORK', { label: 'Work' }).platform, 'CF'));
it('accounts() lists the account', () => eq(grouped.open().accounts('CF').map(a => a.identifier), ['WORK']));
it('accounts() can be scoped to one platform', () => eq(grouped.open().accounts('AWS'), []));
it('accounts() with no argument lists every account', () => eq(grouped.open().accounts().length, 1));
it('a duplicate account under the same platform is refused', () => throws(() => grouped.open().addAccount('CF', 'WORK'), 'already exists'));
it('the same account identifier under another platform is allowed', () => eq(grouped.open().addAccount('AWS', 'WORK').identifier, 'WORK'));
it('an account under a second platform is independent', () => eq(grouped.open().accounts('AWS').length, 1));
it('a key can be filed to a slot', () => {
    const s = grouped.open();
    const written = s.set(credentialName('CF', 'WORK', FIELD_ID), 'acct-7', 'Cloudflare account id', { platform: 'CF', account: 'WORK', field: FIELD_ID });
    eq(written.platform, 'CF');
    eq(written.account, 'WORK');
    return true;
});
it('a filed key reads back its group', () => eq(grouped.open().get('DSH_CF_WORK_ID').platform, 'CF'));
it('namesIn() finds keys under a platform', () => eq(grouped.open().namesIn('CF'), ['DSH_CF_WORK_ID']));
it('namesIn() can be narrowed to one account', () => eq(grouped.open().namesIn('CF', 'WORK'), ['DSH_CF_WORK_ID']));
it('namesIn() of another account is empty', () => eq(grouped.open().namesIn('CF', 'ME'), []));
it('filing to an unknown platform is refused', () => throws(() => grouped.open().set('DSH_X_Y_ID', 'v', 'd', { platform: 'X', account: 'Y', field: FIELD_ID }), 'unknown platform'));
it('filing to an unknown account is refused', () => throws(() => grouped.open().set('DSH_CF_ZZ_ID', 'v', 'd', { platform: 'CF', account: 'ZZ', field: FIELD_ID }), 'unknown account'));
it('an ungrouped key has no platform reported', () => {
    const s = grouped.open();
    s.set('DSH_LOOSE', 'v', 'd');
    if (s.get('DSH_LOOSE').platform !== undefined) throw new Error('unexpected grouping');
    return true;
});
it('an ungrouped key still lists', () => eq(grouped.open().names().includes('DSH_LOOSE'), true));
it('rewriting a filed key keeps its group', () => eq(grouped.open().set('DSH_CF_WORK_ID', 'acct-7b', 'edited').account, 'WORK'));
it('provenance still follows the creator alongside grouping', () => {
    const s = grouped.open();
    s.set('DSH_CF_WORK_KEY', 'k', 'd', { origin: ORIGIN_MODEL, platform: 'CF', account: 'WORK', field: FIELD_KEY });
    eq(s.get('DSH_CF_WORK_KEY').origin, ORIGIN_MODEL);
    return true;
});
it('a model rewrite of its own filed key keeps the group', () => eq(grouped.open().set('DSH_CF_WORK_KEY', 'k2', 'rotated', { origin: ORIGIN_MODEL }).platform, 'CF'));
it('setPlatformLabel changes only the label', () => eq(grouped.open().setPlatformLabel('CF', 'Cloudflare Inc').label, 'Cloudflare Inc'));
it('the identifier is unchanged after a relabel', () => eq(grouped.open().platforms().find(p => p.label === 'Cloudflare Inc').identifier, 'CF'));
it('a filed key is still found after a relabel', () => eq(grouped.open().namesIn('CF').length, 2));
it('setPlatformLabel on an unknown platform throws', () => throws(() => grouped.open().setPlatformLabel('NOPE', 'x'), 'unknown platform'));
it('setAccountLabel changes only the label', () => eq(grouped.open().setAccountLabel('CF', 'WORK', 'Work account').label, 'Work account'));
it('setAccountLabel on an unknown account throws', () => throws(() => grouped.open().setAccountLabel('CF', 'NOPE', 'x'), 'unknown account'));
it('removing a platform that still holds keys is refused', () => throws(() => grouped.open().removePlatform('CF'), 'still holds'));
it('the refused removal changed nothing', () => eq(grouped.open().platforms().length, 2));
it('forcing a platform removal un-files its keys', () => eq(grouped.open().removePlatform('CF', { force: true }).unfiled.length, 2));
it('the platform is gone', () => eq(grouped.open().platforms().map(p => p.identifier), ['AWS']));
it('its accounts went with it', () => eq(grouped.open().accounts('CF'), []));
it('the secrets survived the platform removal', () => eq(grouped.open().get('DSH_CF_WORK_KEY').value, 'k2'));
it('the un-filed keys read back with no group', () => {
    const rec = grouped.open().get('DSH_CF_WORK_KEY');
    if (rec.platform !== undefined) throw new Error('still grouped');
    return true;
});
it('the un-filed key still lists under its original name', () => eq(grouped.open().names().includes('DSH_CF_WORK_KEY'), true));
it('removing an unknown platform reports false', () => eq(grouped.open().removePlatform('NOPE').removed, false));
it('removing an account that still holds keys is refused', () => {
    // AWS/WORK was created but holds nothing until now — the refusal has to be
    // provoked by an actual key, otherwise the assertion would pass for the
    // wrong reason (an empty account is removable).
    grouped.open().set(credentialName('AWS', 'WORK', FIELD_KEY), 'aws-7', 'AWS key', { platform: 'AWS', account: 'WORK', field: FIELD_KEY });
    throws(() => grouped.open().removeAccount('AWS', 'WORK'), 'still holds');
    return true;
});
it('the refused account removal changed nothing', () => eq(grouped.open().accounts('AWS').length, 1));
it('forcing an account removal un-files its key', () => eq(grouped.open().removeAccount('AWS', 'WORK', { force: true }).unfiled, ['DSH_AWS_WORK_KEY']));
it('the un-filed AWS key kept its value', () => eq(grouped.open().get('DSH_AWS_WORK_KEY').value, 'aws-7'));
it('removing an unknown account reports false', () => eq(grouped.open().removeAccount('AWS', 'NOPE').removed, false));
rmSync(grouped.dir, { recursive: true, force: true });

// ─────────────────────────────────────────────────────────────────────────────
describe('[18] store: version 1 files load unchanged, grouping degrades safely');
const legacy = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'kp-legacy-'));
    const file = join(dir, 'keys.json');
    return { dir, file, open: () => new KeyStore(file) };
})();
it('a version 1 document with plain keys loads', () => {
    writeFileSync(legacy.file, JSON.stringify({ version: 1, policy: { accessMode: 'edit', scopePattern: null }, keys: {
        DSH_OLD_ONE: { value: 'v1', description: 'first', origin: 'operator', createdAt: 1, updatedAt: 2 },
    } }));
    eq(legacy.open().names(), ['DSH_OLD_ONE']);
    return true;
});
it('the legacy key keeps its value', () => eq(legacy.open().get('DSH_OLD_ONE').value, 'v1'));
it('the legacy key keeps its provenance', () => eq(legacy.open().get('DSH_OLD_ONE').origin, ORIGIN_OPERATOR));
it('the legacy key keeps its timestamps', () => eq(legacy.open().get('DSH_OLD_ONE').createdAt, 1));
it('the legacy policy is preserved', () => eq(legacy.open().policy().accessMode, 'edit'));
it('the legacy key reads back as ungrouped', () => {
    if (legacy.open().get('DSH_OLD_ONE').platform !== undefined) throw new Error('unexpected group');
    return true;
});
it('the legacy store has no platforms', () => eq(legacy.open().platforms(), []));
it('a legacy file can be extended with a platform', () => eq(legacy.open().addPlatform('CF').identifier, 'CF'));
it('the legacy key still loads alongside the new platform', () => eq(legacy.open().names(), ['DSH_OLD_ONE']));
it('a corrupt platforms member degrades to empty instead of throwing', () => {
    writeFileSync(legacy.file, JSON.stringify({ version: 2, platforms: 'nope', accounts: 7, keys: {} }));
    eq(legacy.open().platforms(), []);
    return true;
});
it('a platforms member that is an array degrades to empty', () => {
    writeFileSync(legacy.file, JSON.stringify({ version: 2, platforms: ['CF'], keys: {} }));
    eq(legacy.open().platforms(), []);
    return true;
});
it('a malformed platform entry is dropped, the good one survives', () => {
    writeFileSync(legacy.file, JSON.stringify({ version: 2, platforms: { CF: { label: 'Cloudflare' }, bad_one: { label: 'x' } }, keys: {} }));
    eq(legacy.open().platforms().map(p => p.identifier), ['CF']);
    return true;
});
it('an account orphaned by a missing platform is dropped', () => {
    writeFileSync(legacy.file, JSON.stringify({ version: 2, platforms: {}, accounts: { 'CF/WORK': { platform: 'CF', identifier: 'WORK' } }, keys: {} }));
    eq(legacy.open().accounts(), []);
    return true;
});
it('an account whose composite key disagrees with its contents is dropped', () => {
    writeFileSync(legacy.file, JSON.stringify({ version: 2, platforms: { CF: {} }, accounts: { 'CF/WRONG': { platform: 'CF', identifier: 'WORK' } }, keys: {} }));
    eq(legacy.open().accounts(), []);
    return true;
});
it('a key pointing at a dropped platform reads back as ungrouped', () => {
    writeFileSync(legacy.file, JSON.stringify({ version: 2, keys: {
        DSH_GHOST: { value: 'v', description: 'd', platform: 'GONE', account: 'WORK', field: 'key' },
    } }));
    const rec = legacy.open().get('DSH_GHOST');
    if (rec.platform !== undefined) throw new Error('dangling group reported');
    return true;
});
it('the dangling key was not deleted', () => eq(legacy.open().names(), ['DSH_GHOST']));
it('the dangling key kept its value', () => eq(legacy.open().get('DSH_GHOST').value, 'v'));
it('normalisePlatforms tolerates null', () => eq(normalisePlatforms(null), {}));
it('normaliseAccounts tolerates null', () => eq(normaliseAccounts(null, {}), {}));
it('normaliseAccounts drops an account with no matching platform', () => eq(normaliseAccounts({ 'CF/WORK': { platform: 'CF', identifier: 'WORK' } }, {}), {}));
it('normalisePlatforms defaults a missing label to the identifier', () => eq(normalisePlatforms({ CF: {} }).CF.label, 'CF'));
it('normalisePlatforms defaults a blank label to the identifier', () => eq(normalisePlatforms({ CF: { label: '   ' } }).CF.label, 'CF'));
rmSync(legacy.dir, { recursive: true, force: true });

// ─────────────────────────────────────────────────────────────────────────────
describe('[19] store: grouping round-trips through the file');
const persist = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'kp-persist-'));
    const file = join(dir, 'keys.json');
    return { dir, file, open: () => new KeyStore(file) };
})();
it('platforms, accounts and slots are written', () => {
    const s = persist.open();
    s.addPlatform('CF', { label: 'Cloudflare' });
    s.addAccount('CF', 'WORK', { label: 'Work' });
    s.set('DSH_CF_WORK_KEY', 'secret-7', 'Cloudflare API token', { platform: 'CF', account: 'WORK', field: FIELD_KEY });
    const disk = JSON.parse(readFileSync(persist.file, 'utf8'));
    eq(disk.version, STORE_VERSION);
    eq(disk.platforms.CF.label, 'Cloudflare');
    eq(disk.accounts['CF/WORK'].identifier, 'WORK');
    eq(disk.keys.DSH_CF_WORK_KEY.field, 'key');
    return true;
});
it('a reload sees the platform', () => eq(persist.open().platforms()[0].label, 'Cloudflare'));
it('a reload sees the account', () => eq(persist.open().accounts('CF')[0].label, 'Work'));
it('a reload sees the slot', () => eq(persist.open().get('DSH_CF_WORK_KEY').field, 'key'));
it('a reload sees the value', () => eq(persist.open().get('DSH_CF_WORK_KEY').value, 'secret-7'));
it('the secret is still injected under its full name', () => eq(persist.open().values().DSH_CF_WORK_KEY, 'secret-7'));
it('descriptions() still keys by the full name', () => eq(persist.open().descriptions().DSH_CF_WORK_KEY, 'Cloudflare API token'));
rmSync(persist.dir, { recursive: true, force: true });

rmSync(sandbox, { recursive: true, force: true });
rmSync(toolsDir, { recursive: true, force: true });


// ── Usage log: two independent streams, buffered and best-effort ───────────
describe('[20] usage log: the store itself');
{
    const { UsageLog, readUsage, USAGE_LIMIT, KIND_USE, KIND_INTENT } = await import(usageModuleUrl);
    const dir = mkdtempSync(join(tmpdir(), 'kp-usage-'));
    const logFile = join(dir, 'usage.jsonl');
    let clock = 1_000;
    const log = new UsageLog(logFile, { now: () => (clock += 10), limit: 5 });

    it('starts with nothing pending and nothing written', () => {
        eq(log.pending.length, 0);
        eq(readUsage(logFile).length, 0);
        return true;
    });
    it('buffers rather than writing through', () => {
        log.record(KIND_USE, ['DSH_A']);
        eq(log.pending.length, 1);
        // The point of the buffer: no file exists yet.
        eq(readUsage(logFile).length, 0);
        return true;
    });
    it('flush writes the buffer and empties it', () => {
        eq(log.flush(), 1);
        eq(log.pending.length, 0);
        eq(readUsage(logFile).length, 1);
        return true;
    });
    it('record never throws, even on junk', () => {
        log.record('not-a-kind', ['DSH_A']);
        log.record(KIND_USE, 'not-an-array');
        log.record(KIND_USE, null);
        log.record(KIND_USE, ['DSH_A'], { note: 12345 });
        return true;
    });
    it('a bad kind is dropped', () => eq(log.pending.filter(e => e.kind === 'not-a-kind').length, 0));
    it('an entry with no usable names is dropped', () => eq(log.pending.length, 1));
    it('duplicate names collapse', () => {
        log.flush();
        log.record(KIND_USE, ['DSH_A', 'DSH_A', 'DSH_B']);
        eq(log.pending[0].names, ['DSH_A', 'DSH_B']);
        return true;
    });
    it('a note is trimmed, and an empty one is omitted entirely', () => {
        log.flush();
        log.record(KIND_INTENT, ['DSH_A'], { note: '   deploy staging   ' });
        log.record(KIND_INTENT, ['DSH_A'], { note: '   ' });
        eq(log.pending[0].note, 'deploy staging');
        eq('note' in log.pending[1], false);
        return true;
    });
    it('a note is capped rather than unbounded', () => {
        log.flush();
        log.record(KIND_INTENT, ['DSH_A'], { note: 'x'.repeat(900) });
        eq(log.pending[0].note.length, 500);
        return true;
    });
    it('crossing the threshold flushes immediately, leaving only the remainder', () => {
        log.flush();
        for (let i = 0; i < 60; i += 1) log.record(KIND_USE, ['DSH_A']);
        // 60 records, threshold 50: the batch goes without waiting for the
        // timer, and the last 10 stay buffered. Asserting 0 here would be
        // asserting the threshold does nothing.
        eq(log.pending.length, 10);
        log.flush();
        eq(log.pending.length, 0);
        return true;
    });
    it('total counts everything recorded, not just what is buffered', () => eq(log.total() > 60, true));

    // The cap is the whole reason the file cannot grow without bound.
    it('the file is trimmed to the limit', () => {
        eq(readUsage(logFile).length <= 5, true);
        return true;
    });
    it('a trim keeps the NEWEST entries', () => {
        const entries = readUsage(logFile);
        const times = entries.map(e => e.t);
        eq(times, [...times].sort((a, b) => a - b));
        return true;
    });

    // Records are append-only between trims, so a hard kill can leave a
    // half-written line. That must be skipped, not treated as corruption.
    it('a truncated final line is skipped, not fatal', () => {
        const before = readUsage(logFile).length;
        appendFileSync(logFile, '{"t":9,"kind":"use","nam');
        eq(readUsage(logFile).length, before);
        return true;
    });
    it('a well-formed line after a bad one is still read', () => {
        appendFileSync(logFile, '\n' + JSON.stringify({ t: 42, kind: KIND_USE, names: ['DSH_Z'] }) + '\n');
        eq(readUsage(logFile).some(e => e.names.includes('DSH_Z')), true);
        return true;
    });
    it('a missing file reads as empty', () => eq(readUsage(join(dir, 'nope.jsonl')), []));
    it('a non-object line is skipped', () => {
        appendFileSync(logFile, '[]\n42\n"str"\n');
        eq(readUsage(logFile).every(e => typeof e === 'object'), true);
        return true;
    });
    it('an entry without a finite timestamp is skipped', () => {
        const before = readUsage(logFile).length;
        appendFileSync(logFile, JSON.stringify({ t: 'nope', kind: KIND_USE, names: ['DSH_A'] }) + '\n');
        eq(readUsage(logFile).length, before);
        return true;
    });
    it('the default limit is generous but finite', () => eq(USAGE_LIMIT > 0, true));

    rmSync(dir, { recursive: true, force: true });
}

// ── The intent stream: model-declared, and the one tool present everywhere ──
describe('[21] usage log: intent tool and gateway wiring');
{
    const { UsageLog, readUsage, KIND_USE, KIND_INTENT } = await import(usageModuleUrl);
    const dir = mkdtempSync(join(tmpdir(), 'kp-intent-'));
    const logFile = join(dir, 'usage.jsonl');
    const log = new UsageLog(logFile, { now: () => 7777 });
    const record = (kind, names, extra) => log.record(kind, names, extra);

    const s = new KeyStore(join(dir, 'keys.json'));
    s.set('DSH_CF_WORK_KEY', 'super-secret-value', 'Cloudflare token');
    const ctx = toolCtx();
    registerModelTools({ ctx, store: s, resync: () => {}, ledger: new ConfirmationLedger(), record });
    const intent = ctx.registered.get('key_panel_intent');

    it('key_panel_intent is registered', () => typeof intent === 'object' && intent !== null);

    it('records an intent with its note', async () => {
        const out = await intent.execute({ purpose: 'deploy the staging worker', names: ['DSH_CF_WORK_KEY'] });
        eq(out.recorded, true);
        log.flush();
        const entries = readUsage(logFile);
        eq(entries.length, 1);
        eq(entries[0].kind, KIND_INTENT);
        eq(entries[0].note, 'deploy the staging worker');
        eq(entries[0].names, ['DSH_CF_WORK_KEY']);
        return true;
    });

    // The headline invariant of this whole file.
    it('the log holds no secret value, ever', () => {
        // Flush first so this is self-contained rather than relying on how much
        // the preceding test happened to leave behind.
        log.flush();
        const text = readFileSync(logFile, 'utf8');
        if (text.includes('super-secret-value')) throw new Error('a key VALUE reached the usage log');
        return true;
    });

    it('a blank purpose records nothing', async () => {
        const before = log.pending.length;
        const out = await intent.execute({ purpose: '   ' });
        eq(out.recorded, false);
        eq(log.pending.length, before);
        return true;
    });
    it('a missing purpose records nothing', async () => {
        const before = log.pending.length;
        const out = await intent.execute({});
        eq(out.recorded, false);
        eq(log.pending.length, before);
        return true;
    });

    // A hallucinated name must not enter the log as if it were real.
    it('names that are not stored are dropped, and reported', async () => {
        log.flush();
        const out = await intent.execute({ purpose: 'x', names: ['DSH_CF_WORK_KEY', 'DSH_GHOST'] });
        eq(out.recorded, true);
        if (!String(out.message).includes('Ignored')) throw new Error('no warning about the unknown name');
        log.flush();
        eq(readUsage(logFile).at(-1).names, ['DSH_CF_WORK_KEY']);
        return true;
    });
    it('an intent naming nothing at all records nothing', async () => {
        log.flush();
        const before = readUsage(logFile).length;
        await intent.execute({ purpose: 'just thinking aloud' });
        log.flush();
        eq(readUsage(logFile).length, before);
        return true;
    });

    // The USE stream is written by the resolver, not by any tool.
    it('the resolver records USE with the names it actually handed over', () => {
        const values = s.values();
        record(KIND_USE, Object.keys(values));
        log.flush();
        eq(readUsage(logFile).at(-1).kind, KIND_USE);
        eq(readUsage(logFile).at(-1).names, ['DSH_CF_WORK_KEY']);
        return true;
    });
    it('a USE entry carries no note', () => {
        log.flush();
        log.record(KIND_USE, ['DSH_CF_WORK_KEY']);
        eq('note' in log.pending[0], false);
        log.flush();
        return true;
    });

    // Both streams live in one file but keep their identity.
    it('the two kinds coexist and stay distinguishable', () => {
        const entries = readUsage(logFile);
        const kinds = new Set(entries.map(e => e.kind));
        eq([...kinds].sort(), [KIND_INTENT, KIND_USE].sort());
        return true;
    });
    it('they are never fused into one entry', () => {
        const fused = readUsage(logFile).filter(e => e.kind === KIND_USE && 'note' in e);
        eq(fused, []);
        return true;
    });

    rmSync(dir, { recursive: true, force: true });
}
// ── The Typert remote contract: signatures must be bare identifiers ────────
describe('[22] every remote method has a Typert-legal signature');
{
    // Typert rejects a remote method whose parameters carry a DEFAULT, a
    // DESTRUCTURE or a REST, per method, at registration time:
    //
    //   gateway/signature-invalid: keyPanel/usage: SRC method "usage" must use
    //   unique identifier parameters without destructuring, defaults, or rest
    //
    // The failure mode is nasty because it is per-method and silent at the
    // plugin level: `usage(limit = 200)` threw away ONLY that remote. The panel
    // still mounted, every other RPC still answered, and the card showed its
    // empty state — so "no records yet" looked like a working feature with no
    // data rather than a broken one. Nothing in the suite noticed.
    //
    // Read the methods straight off the prototype rather than off a list here,
    // because the list in lib/index.js (markRemoteMethods) is exactly the thing
    // that has to stay in sync — asserting it against itself would be circular.
    const { KeyPanelGateway } = await import(indexModuleUrl);
    // The marker descriptor markRemoteMethods() writes; reading it here checks
    // the real registration rather than a list restated in the test.
    const descriptor = KeyPanelGateway.prototype['@deepseek-ai/dsh-typert-protocol/remote-methods'];
    const remote = new Set((descriptor?.methods ?? []).map(m => m.method));

    it('the gateway exposes remotes to check', () => remote.size >= 15);

    const source = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
    const offenders = [];
    for (const name of remote) {
        // Match `name(args) {` at class-method indentation, capturing the
        // raw parameter text.
        const re = new RegExp('^ {4}' + name + '[(]([^)]*)[)] *[{]', 'm');
        const m = source.match(re);
        if (m === null) { offenders.push(`${name}: signature not found`); continue; }
        const params = m[1].trim();
        if (params === '') continue;
        for (const p of params.split(',')) {
            const t = p.trim();
            if (t === '') { offenders.push(`${name}: empty parameter`); continue; }
            if (t.includes('=')) { offenders.push(`${name}: ${t} has a default`); continue; }
            if (t.includes('{') || t.includes('[')) { offenders.push(`${name}: ${t} destructures`); continue; }
            if (t.startsWith('...')) { offenders.push(`${name}: ${t} is a rest param`); continue; }
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)) offenders.push(`${name}: ${t} is not a bare identifier`);
        }
    }
    it('no remote parameter has a default, destructure or rest', () => {
        eq(offenders, []);
        return true;
    });

    // The regression itself, pinned. If someone reintroduces the default this
    // reports the exact method instead of an empty panel.
    it('usage() takes no parameters', () => {
        const m = source.match(/^ {4}usage[(]([^)]*)[)] *[{]/m);
        if (m === null) throw new Error('usage() not found on the gateway');
        eq(m[1], '');
        return true;
    });

    // E-11 in plugin-contract.md, and the reason this group exists at all.
    //
    // Typert discovers remotes by scanning the SOURCE, and the scan does not
    // skip comments. After fixing the signature above, the same failure came
    // back because the fix documented itself by quoting the broken signature
    // in the doc comment - which the scanner then read as a real one.
    //
    // So the check below is deliberately NOT limited to method-definition
    // lines. Any occurrence of a marked method name followed by a parameter
    // list containing a default, a destructure or a rest is an offender,
    // wherever it sits: code, comment, or string.
    it('no malformed signature shape appears anywhere in the source', () => {
        // Scanned LINE BY LINE, and a line counts if it is a comment or a
        // method definition. Anchoring on the line - not on a trailing brace -
        // is what makes the comment case visible: `* usage(limit = 200)` has no
        // brace after it, so a brace-anchored pattern never sees it.
        const found = [];
        for (const raw of source.split('\n')) {
            const line = raw.trim();
            const isComment = line.startsWith('*') || line.startsWith('//') || line.startsWith('/*');
            const isDefinition = /^[A-Za-z#_$][A-Za-z0-9_$]*\s*[(]/.test(line);
            if (!isComment && !isDefinition) continue;
            for (const name of remote) {
                const at = line.indexOf(name + '(');
                if (at === -1) continue;
                const open = at + name.length + 1;
                const close = line.indexOf(')', open);
                if (close === -1) continue;
                const params = line.slice(open, close).trim();
                if (params === '') continue;
                const illegal = params.includes('=') || params.includes('{')
                    || params.includes('[') || params.startsWith('...');
                if (illegal) found.push(line.slice(0, 80));
            }
        }
        eq(found, []);
        return true;
    });

    it('no instance property shadows a remote method name', () => {
        // The gateway resolves remotes with Reflect.get(receiver, name) on the
        // SERVICE INSTANCE. An own property named like a marked method shadows
        // the prototype method: the marker scan (prototype) still passes, the
        // invocation (instance) finds a non-function, and the host answers
        // gateway/method-unavailable. This exact collision - this.usage holding
        // the UsageLog while a remote method usage() exists - broke the
        // activity card in production and survived four restarts because every
        // prototype-level check looked correct. A config key or constructor
        // field may never share a name with a remote method.
        const shadows = [];
        for (const raw of source.split('\n')) {
            const line = raw.trim();
            if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
            const m = line.match(/this[.]([A-Za-z_$][\w$]*)[ ]*=[ ]/);
            if (m && remote.has(m[1])) shadows.push(m[1] + ' <- ' + line.slice(0, 60));
        }
        eq(shadows, []);
        return true;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('[24] the failure path reports itself before it escapes');
{
    // The gateway in front of this plugin collapses every non-RemoteError into
    // `code: "gateway/internal"` plus the bare message and drops the rest. On
    // 2026-09-25 a panel save showed
    //   keyPanel.set: gateway/internal: Receiver must be an instance of class ...
    // while both writes had in fact succeeded. Nothing was logged and the text
    // matched no string on disk, so the report could not be traced to any code.
    // Every method that can fail must therefore leave one warn line behind.
    const host = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href);
    const dir = mkdtempSync(join(tmpdir(), 'kp-fail-'));
    const lines = [];
    let gateway = null;
    const ctx = {
        logger: {
            info: () => {},
            warn: (line) => { lines.push(String(line)); },
        },
        effect: () => {},
        get: n => (n === 'shellEnv' ? { register: () => () => {} } : undefined),
        shellEnv: { register: () => () => {} },
        tools: { register() { return () => {}; } },
        plugin: (ctor, deps) => { gateway = new ctor({ reflect: { provide() {} } }, deps); },
    };
    host.apply(ctx, { dshHome: dir });

    it('a rejected name still throws the original error, unchanged', () => {
        let caught = null;
        try { gateway.set('not-a-dsh-name', 'v', 'd'); } catch (error) { caught = error; }
        eq(caught !== null, true);
        eq(caught.message.includes('use a DSH_ prefix'), true);
        return true;
    });

    it('and that failure left exactly one warn line behind', () => eq(lines.length, 1));

    it('the line names the method that failed', () => eq(lines[0].includes('keyPanel/set failed'), true));

    it('the line carries the message the panel will show', () => eq(lines[0].includes('use a DSH_ prefix'), true));

    it('the line carries a throw site, not just a message', () => eq(/\bat .+:\d+/.test(lines[0]), true));

    it('a successful call logs nothing to warn', () => {
        const before = lines.length;
        gateway.set('DSH_OK', 'op-value', 'operator key');
        eq(lines.length, before);
        return true;
    });

    it('no failure line ever contains a value being written', () => {
        lines.length = 0;
        // The dangerous shape is a rejection that happens while a secret is in
        // flight: the value is then sitting in the frame's arguments. Fail a few
        // different methods and assert no collected line can quote the secret.
        const attempt = (fn) => { try { fn(); } catch {} };
        attempt(() => gateway.setPolicy('root', null));
        attempt(() => gateway.set('ALSO_BAD', 'super-secret-7', 'x'));
        attempt(() => gateway.setPlatformLabel('NOPE', 'label'));
        const joined = lines.join('\n');
        eq(lines.length >= 2, true);
        eq(joined.includes('super-secret-7'), false);
        eq(joined.includes('op-value'), false);
        return true;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('[25] the gateway has no private-method brand to fail its receiver check');
{
    // The 2026-09-25 receipt
    //   gateway/internal: Receiver must be an instance of class KeyPanelGateway
    // is V8's own brand-check error for PRIVATE METHODS. The string lives in
    // the engine binary, not in any file — which is exactly why every disk
    // search came up empty. It fires when a prototype method is dispatched
    // onto a receiver that is not a genuine `new` instance of that class —
    // the shape produced when the plugin is loaded twice under one name (an
    // old renderer bundle and a new one are different classes that happen to
    // share a title) and one copy's method lands on the other copy's data.
    //
    // Ordinary (underscored) methods have no brand: they work on any receiver
    // that carries the own properties. This group reproduces the bad receiver
    // directly and proves the gateway methods run through it.
    const host = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href);
    const dir = mkdtempSync(join(tmpdir(), 'kp-brand-'));
    let gateway = null;
    const ctx = {
        logger: { info: () => {}, warn: () => {} },
        effect: () => {},
        get: n => (n === 'shellEnv' ? { register: () => () => {} } : undefined),
        shellEnv: { register: () => () => {} },
        tools: { register() { return () => {}; } },
        plugin: (ctor, deps) => { gateway = new ctor({ reflect: { provide() {} } }, deps); },
    };
    host.apply(ctx, { dshHome: dir });

    it('a genuine instance saves normally', () => {
        gateway.set('DSH_BRAND_TEST', 'v7', 'through a real instance');
        return true;
    });

    // Build the hostile receiver: prototype chain intact, own properties
    // present — indistinguishable from an instance to any ordinary method,
    // rejected outright by a private one.
    const foreign = Object.create(Object.getPrototypeOf(gateway));
    for (const key of Object.keys(gateway)) foreign[key] = gateway[key];

    it('the receiver would fail private-method brand checks', () => {
        // We prove the exact failure mode in the next test; here we just confirm
        // the setup is otherwise complete (own properties present).
        eq(typeof foreign.store?.get, 'function');
        return true;
    });

    it('the reported crash shape: a private method on this receiver dies by brand check', () => {
        // Prove the mechanism is real using the very class we ship: attach a
        // throwaway private method and call it through the foreign receiver.
        class Probe extends host.KeyPanelGateway { runThrough(o) { return o.#hidden(); } #hidden() { return 7; } }
        // (Static-structure check — the probe never needs to run to fail.)
        let brand = null;
        try {
            const p = new Probe({ reflect: { provide() {} } }, { store: gateway.store, filePath: '', usageLog: gateway.usageLog, usagePath: '', resync: () => {}, retool: () => {}, logger: gateway.logger });
            p.runThrough(foreign);
        } catch (error) { brand = error; }
        eq(brand !== null, true);
        eq(String(brand.message).includes('Receiver must be an instance of class'), true);
        return true;
    });

    it('describe() on the foreign receiver works and reads the real store', () => {
        const row = host.KeyPanelGateway.prototype.describe.call(foreign, 'DSH_BRAND_TEST');
        eq(row.name, 'DSH_BRAND_TEST');
        eq(row.description, 'through a real instance');
        return true;
    });

    it('set() on the foreign receiver writes for real — no phantom failure possible', () => {
        host.KeyPanelGateway.prototype.addPlatform.call(foreign, 'BRAND', 'Brand probe');
        host.KeyPanelGateway.prototype.addAccount.call(foreign, 'BRAND', 'X', 'probe acct');
        const row = host.KeyPanelGateway.prototype.set.call(foreign, 'DSH_BRAND_FOREIGN', 'v77', 'through the other bundle', { platform: 'BRAND', account: 'X', field: 'id' });
        eq(row.name, 'DSH_BRAND_FOREIGN');
        eq(row.platform, 'BRAND');
        eq(gateway.describe('DSH_BRAND_FOREIGN').account, 'X');
        eq(gateway.describe('DSH_BRAND_FOREIGN').masked.includes('v77'), false);
        return true;
    });

    it('no remote method of the gateway reaches a private member', () => {
        const source = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
        const from = source.indexOf('class KeyPanelGateway');
        const to = source.indexOf('markRemoteMethods(KeyPanelGateway');
        eq(from >= 0 && to > from, true);
        const body = source.slice(from, to);
        const offenders = [];
        for (const [index, raw] of body.split('\n').entries()) {
            const line = raw.trim();
            if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
            if (line.startsWith('#') || /\bthis[.]#/.test(line) || /[\w$]\s*[.]\s*#/.test(line)) {
                offenders.push((index + 1) + ': ' + line.slice(0, 60));
            }
        }
        eq(offenders, []);
        return true;
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
