/**
 * Client-bundle tests: load lib/client.js the way the DSH web frontend does,
 * then assert the module contract, the registration shape and the RPC surface.
 *
 * This does not run React (no react-dom in this repo). It evaluates the factory,
 * checks the exports, the slot registration and every RPC the panel issues, and
 * walks the VNode trees of the two components exported for the purpose.
 *
 * That last part exists because a plain load-and-inspect cannot catch a syntax
 * error inside the factory body — the body is a string until the loader
 * materialises it, so the file can be unparseable while every other assertion
 * passes. Both mistakes of that shape made during development were found by
 * rendering, not by the suite.
 *
 * Run: node test/client.mjs
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

let passed = 0;
let failed = 0;
const describe = name => console.log(`\n${name}`);
const it = (label, fn) => {
    try {
        if (fn() === false) throw new Error('returned false');
        passed += 1;
        console.log(`  ✓ ${label}`);
    }
    catch (error) {
        failed += 1;
        console.log(`  ✗ ${label} — ${error?.message ?? error}`);
    }
};
const eq = (actual, expected) => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`expected ${b}, got ${a}`);
    return true;
};

// ── Load the bundle exactly as the frontend loader does ─────────────────────
const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8');
let captured = null;
let domTouched = false;
globalThis.window = {
    __ModuleLoader__: { load: record => { captured = record; } },
    get document() { domTouched = true; return undefined; },
};

// The bundle is a script, not an ES module: evaluating it must only REGISTER.
// Any CSS injection or DOM access at this point would be a contract violation —
// the loader materialises the factory later, and doing work now would run it
// once per process instead of once per activation.
new Function(source)();

describe('[1] bundle envelope');
it('registered through __ModuleLoader__.load', () => captured !== null);
// The host keys the client module graph by PACKAGE NAME and rejects a bundle
// that registers anything else ("bundle ... loaded without registering ...
// via __ModuleLoader__.load"). Asserting against package.json rather than a
// literal is the whole point: a rename that misses this file must fail here
// rather than at runtime as a missing settings panel.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
it(`loader id equals the package name (${pkg.name})`, () => eq(captured?.id, pkg.name));
it('factory is a function', () => typeof captured.factory === 'function');
it('evaluating the bundle only registers (no DOM access)', () => domTouched === false);

// ── Instantiate the factory with seed-word stand-ins ────────────────────────
const SEED = new Set([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
]);

const requiredSpecs = [];
const reactStub = {
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
};
// A Proxy lets any primitive (Button, Input, Tag, Icon*, Toast, Modal, ...)
// resolve without enumerating the kit's ~100 exports here.
const primitivesStub = new Proxy({}, {
    get: (_target, prop) => {
        if (prop === 'writeClipboard') return async () => {};
        return () => null;
    },
});

const requireShim = spec => {
    requiredSpecs.push(spec);
    if (!SEED.has(spec)) throw new Error(`NON-SEED IMPORT: ${spec}`);
    if (spec === 'react') return reactStub;
    if (spec === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null };
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
    throw new Error(`unexpected seed word: ${spec}`);
};

const exportsObj = captured.factory(requireShim);

describe('[2] module exports');
it('exports an object', () => typeof exportsObj === 'object' && exportsObj !== null);
it('exports apply', () => typeof exportsObj.apply === 'function');
it('exports a namespace', () => eq(exportsObj.NS, 'settings.key-panel'));
it('inject is slots, locale, connection', () => eq(exportsObj.inject, ['slots', 'locale', 'connection']));
it('every require() was a seed word', () => eq([...new Set(requiredSpecs)].sort(),
    ['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime'].sort()));

// ── apply() against a stub cordis context ───────────────────────────────────
describe('[3] slot registration');

let registered = null;
const makeCtx = (rpcCall) => ({
    effect: () => {},
    get: name => (name === 'connection' ? { rpc: { call: rpcCall ?? (async () => ({ ok: true, value: null })) } } : undefined),
    locale: { register: () => {}, bind: () => key => key },
    slots: {
        inject: (name, fn) => { if (name !== 'settings.section') throw new Error(`unexpected slot ${name}`); fn(); },
        register: (options, component) => { registered = { options, component }; return () => {}; },
    },
});

exportsObj.apply(makeCtx());

it('registered into settings.section', () => eq(registered?.options?.name, 'settings.section'));
it('carries an id (list slot requires one)', () => eq(registered?.options?.id, 'key-panel'));
it('sorts after general/models/vault', () => eq(registered?.options?.order, 40));
it('label is a thunk', () => typeof registered?.options?.label === 'function');
it('locale names the dictionary', () => eq(registered?.options?.locale, 'settings.key-panel'));
it('inject is a thunk', () => typeof registered?.options?.inject === 'function');
it('component is a function', () => typeof registered?.component === 'function');

// ── The injected surface the section consumes ───────────────────────────────
describe('[4] injected surface');
const injected = registered.options.inject();
for (const fnName of ['list', 'status', 'setKey', 'removeKey', 'revealKey', 'getPolicy', 'setPolicy',
    'groups', 'addPlatform', 'setPlatformLabel', 'removePlatform',
    'addAccount', 'setAccountLabel', 'removeAccount', 'credentialNames', 'usage']) {
    it(`injected.${fnName} is a function`, () => typeof injected[fnName] === 'function');
}
it('injected.t is a function', () => typeof injected.t === 'function');

// ── RPC endpoints must match the host gateway ───────────────────────────────
describe('[5] RPC endpoints');
const calls = [];
const ctx = makeCtx(async (channel, endpoint, payload) => {
    calls.push({ channel, endpoint, payload });
    return { ok: true, value: {} };
});
registered = null;
const exportsObj2 = captured.factory(requireShim);
exportsObj2.apply(ctx);
const api = registered.options.inject();

await api.list();
await api.status();
await api.setKey('DSH_X', 'v', 'd');
await api.removeKey('DSH_X');
await api.revealKey('DSH_X');
await api.getPolicy();
await api.setPolicy('edit', 'DSH_AGENT_*');
await api.groups();
await api.addPlatform('CF', 'Cloudflare');
await api.setPlatformLabel('CF', 'Cloudflare Inc');
await api.removePlatform('CF', true);
await api.addAccount('CF', 'WORK', 'Work');
await api.setAccountLabel('CF', 'WORK', 'Work acct');
await api.removeAccount('CF', 'WORK', true);
await api.credentialNames('CF', 'WORK');

it('every call uses the /api channel', () => eq(calls.every(c => c.channel === '/api'), true));
it('endpoints match the gateway', () => eq(calls.map(c => c.endpoint), [
    'keyPanel/list', 'keyPanel/status', 'keyPanel/set',
    'keyPanel/remove', 'keyPanel/reveal', 'keyPanel/getPolicy', 'keyPanel/setPolicy',
    'keyPanel/groups',
    'keyPanel/addPlatform', 'keyPanel/setPlatformLabel', 'keyPanel/removePlatform',
    'keyPanel/addAccount', 'keyPanel/setAccountLabel', 'keyPanel/removeAccount',
    'keyPanel/credentialNames',
]));
it('set() sends {keyName, value, description, slot}',
    () => eq(calls[2].payload.args, { keyName: 'DSH_X', value: 'v', description: 'd', slot: null }));
it('remove() sends {keyName}', () => eq(calls[3].payload.args, { keyName: 'DSH_X' }));
it('reveal() sends {keyName}', () => eq(calls[4].payload.args, { keyName: 'DSH_X' }));
it('setPolicy() sends {accessMode, scopePattern}',
    () => eq(calls[6].payload.args, { accessMode: 'edit', scopePattern: 'DSH_AGENT_*' }));
// The slot is ONE nested field named "slot" — it is NOT spread into the args.
//
// Typert derives a remote's wire fields from the HOST METHOD'S PARAMETER NAMES,
// and set() is declared set(keyName, value, description, slot). Spreading
// platform/account/field produced three names the descriptor does not list, and
// the gateway refused every filed write:
//
//   gateway/arguments-invalid: keyPanel/set: args fields do not match the
//   descriptor: unexpected "platform", "account", "field"
//
// The whole fill-in-from-an-account popup was unsavable and this suite stayed
// green, because the stub below returns {ok:true} for any payload and never
// checks it against a descriptor. Group [23] is the check that would have.
it('setKey() nests the slot under "slot" when one is given',
    async () => {
        calls.length = 0;
        await api.setKey('DSH_CF_WORK_KEY', 'v', 'd', { platform: 'CF', account: 'WORK', field: 'key' });
        eq(calls[0].payload.args, { keyName: 'DSH_CF_WORK_KEY', value: 'v', description: 'd', slot: { platform: 'CF', account: 'WORK', field: 'key' } });
        return true;
    });
it('setKey() names "slot" even when none is given',
    async () => {
        // Present-but-null, not absent: the descriptor lists "slot", so omitting
        // it would be a MISSING field. The host reads a nullish slot as "leave
        // the existing filing alone", which is the same thing an absent one did.
        calls.length = 0;
        await api.setKey('DSH_X', 'v', 'd');
        eq(calls[0].payload.args, { keyName: 'DSH_X', value: 'v', description: 'd', slot: null });
        return true;
    });
// Re-issue the grouping calls against a fresh log before asserting on them.
// The setKey assertions above clear the log, so replaying here keeps this block
// self-contained rather than dependent on how many calls ran before it.
calls.length = 0;
await api.groups();
await api.addPlatform('CF', 'Cloudflare');
await api.setPlatformLabel('CF', 'Cloudflare Inc');
await api.removePlatform('CF', true);
await api.addAccount('CF', 'WORK', 'Work');
await api.setAccountLabel('CF', 'WORK', 'Work acct');
await api.removeAccount('CF', 'WORK', true);
await api.credentialNames('CF', 'WORK');
await api.usage();
const argsFor = endpoint => calls.find(c => c.endpoint === `keyPanel/${endpoint}`)?.payload.args;
it('addPlatform() sends {identifier, label}',
    () => eq(argsFor('addPlatform'), { identifier: 'CF', label: 'Cloudflare' }));
it('setPlatformLabel() sends {identifier, label}',
    () => eq(argsFor('setPlatformLabel'), { identifier: 'CF', label: 'Cloudflare Inc' }));
it('removePlatform() sends {identifier, force}',
    () => eq(argsFor('removePlatform'), { identifier: 'CF', force: true }));
it('addAccount() sends {platform, identifier, label}',
    () => eq(argsFor('addAccount'), { platform: 'CF', identifier: 'WORK', label: 'Work' }));
it('setAccountLabel() sends {platform, identifier, label}',
    () => eq(argsFor('setAccountLabel'), { platform: 'CF', identifier: 'WORK', label: 'Work acct' }));
it('removeAccount() sends {platform, identifier, force}',
    () => eq(argsFor('removeAccount'), { platform: 'CF', identifier: 'WORK', force: true }));
it('credentialNames() sends {platform, account}',
    () => eq(argsFor('credentialNames'), { platform: 'CF', account: 'WORK' }));
// Takes no arguments because the host remote does not: Typert rejects a remote
// whose parameters carry a default, a destructure or a rest, and the original
// `usage(limit = 200)` failed registration exactly that way. The panel rendered
// fine and only the card was empty, which is why this is asserted here rather
// than trusted to the host ignoring an extra argument.
it('usage() sends no arguments', () => eq(argsFor('usage'), {}));

// ── Errors from the host must surface, not be swallowed ─────────────────────
describe('[6] RPC error propagation');
const failCtx = makeCtx(async () => ({ ok: false, error: { code: 'FORBIDDEN', message: 'nope' } }));
registered = null;
captured.factory(requireShim).apply(failCtx);
const failApi = registered.options.inject();
for (const [label, fn] of [
    ['list', () => failApi.list()],
    ['revealKey', () => failApi.revealKey('DSH_X')],
    ['setPolicy', () => failApi.setPolicy('edit', null)],
]) {
    it(`${label} rejects with the host's code`, async () => {
        try {
            await fn();
        }
        catch (error) {
            if (!String(error.message).includes('FORBIDDEN')) throw new Error(`message lacked the code: ${error.message}`);
            return true;
        }
        throw new Error('did not reject');
    });
}

// ── The exact wording the operator sees ─────────────────────────────────────
// The panel shows this string verbatim, and it is the only trace a failed call
// leaves on screen. On 2026-09-25 a save reported
//   keyPanel.set: gateway/internal: Receiver must be an instance of class ...
// while the host had in fact stored both values — so the wording has to be
// pinned, and it has to keep naming the endpoint, the code and the host message
// in that order. Losing any third of it is how a report becomes untraceable.
{
    const ctx = makeCtx(async () => ({ ok: false, error: { code: 'gateway/internal', message: 'boom from the host' } }));
    registered = null;
    captured.factory(requireShim).apply(ctx);
    const api = registered.options.inject();
    it('a gateway/internal failure renders endpoint, code and message in order', async () => {
        try {
            await api.setKey('DSH_X', 'v', 'd');
        }
        catch (error) {
            eq(error.message, 'keyPanel.set: gateway/internal: boom from the host');
            return true;
        }
        throw new Error('did not reject');
    });
    it('a failure with no code is still rendered, marked unknown', async () => {
        const ctx2 = makeCtx(async () => ({ ok: false, error: { message: 'bare' } }));
        registered = null;
        captured.factory(requireShim).apply(ctx2);
        const api2 = registered.options.inject();
        try {
            await api2.list();
        }
        catch (error) {
            eq(error.message, 'keyPanel.list: unknown: bare');
            return true;
        }
        throw new Error('did not reject');
    });
}

// ── Dictionary completeness: every key used must be defined ─────────────────
describe('[7] dictionaries');
{
    // The dictionaries are module-private, so extract them from the source and
    // confirm both languages define the same keys. A missing key renders as a
    // raw identifier in the UI, which is a silent cosmetic bug.
    const zhStart = source.indexOf('const zh = {');
    const enStart = source.indexOf('const en = {');
    // The block ends at the closing "};" that sits at the same indent depth as
    // the opening "const". Matching "\n};" alone would also hit a nested object
    // closing brace, so anchor on the exact leading whitespace of the opener.
    const indentOf = index => source.slice(source.lastIndexOf('\n', index) + 1, index);
    const blockEnd = (from, indent) => {
        const marker = `\n${indent}};`;
        const at = source.indexOf(marker, from);
        if (at === -1) throw new Error('could not find the end of a dictionary block');
        return at;
    };
    const zhIndent = indentOf(zhStart);
    const enIndent = indentOf(enStart);
    const zhBlock = source.slice(zhStart, blockEnd(zhStart, zhIndent));
    const enBlock = source.slice(enStart, blockEnd(enStart, enIndent));
    // Indentation-agnostic: the file is tab-indented, so "any leading
    // whitespace" is the only safe anchor. Only plain `key:` / `key: value`
    // lines qualify; `//` comment lines and nested braces are skipped.
    const keyOf = block => [...block.matchAll(/^[ \t]+([A-Za-z][A-Za-z0-9_]*):/gm)]
        .map(m => m[1])
        .sort();
    const zhKeys = keyOf(zhBlock);
    const enKeys = keyOf(enBlock);
    it(`zh defines ${zhKeys.length} strings`, () => zhKeys.length >= 40);
    it('zh and en define the same keys', () => eq(zhKeys, enKeys));
    it('both dictionaries cover the access modes', () => {
        for (const key of ['modeReadonly', 'modeWrite', 'modeEdit', 'modeReadonlyDesc', 'modeWriteDesc', 'modeEditDesc']) {
            if (!zhKeys.includes(key)) throw new Error(`zh missing ${key}`);
            if (!enKeys.includes(key)) throw new Error(`en missing ${key}`);
        }
        return true;
    });
    it('both dictionaries cover the policy card', () => {
        for (const key of ['policyTitle', 'policyLead', 'scopeLabel', 'scopeHint', 'warnEdit']) {
            if (!zhKeys.includes(key)) throw new Error(`zh missing ${key}`);
            if (!enKeys.includes(key)) throw new Error(`en missing ${key}`);
        }
        return true;
    });
    it('both dictionaries cover the origin badges', () => {
        for (const key of ['originOperator', 'originModel']) {
            if (!zhKeys.includes(key)) throw new Error(`zh missing ${key}`);
            if (!enKeys.includes(key)) throw new Error(`en missing ${key}`);
        }
        return true;
    });
}

// ── No secret-looking literals committed to the bundle ─────────────────────
describe('[8] hygiene');
it('the bundle contains no absolute user path', () => {
    if (/[A-Za-z]:\\\\Users\\\\/.test(source) || source.includes('C:/Users/')) throw new Error('a machine path is baked in');
    return true;
});
it('the bundle does not hardcode a key value', () => {
    if (/sk-[A-Za-z0-9]{20,}/.test(source)) throw new Error('something looks like a live key');
    return true;
});
it('the CSS guard is idempotent by tag id', () => {
    if (!source.includes('data-plugin-css')) throw new Error('missing the css guard');
    return true;
});

// ── The name must agree across all three files, or the plugin cannot start ──
describe('[9] package name consistency');
{
    // Three independent places must carry the same string:
    //   1. package.json `name`            — what npm publishes
    //   2. cordis.patch.yml insert `name` — what the host loader imports
    //   3. lib/client.js loader `id`      — how the bundle identifies itself
    // A mismatch in (2) fails resolution at startup; a mismatch in (3) throws
    // "loaded without registering ..." and the settings panel silently never
    // appears. Both were hit in practice, so this is asserted directly.
    const patchSource = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
    const row = /-\s*id:\s*(\S+)\s*\n\s*name:\s*"?([^"\n]+?)"?\s*$/m.exec(patchSource);

    it('cordis.patch.yml has an insert row with id and name', () => row !== null);
    it('patch row name equals the package name', () => eq(row?.[2], pkg.name));
    it('client loader id equals the patch row name', () => eq(captured?.id, row?.[2]));
    it('patch row id is independent of the package name', () => {
        if (row?.[1] === pkg.name) throw new Error('the row id must NOT be the package name — applyEntryPatches matches insert[].id');
        return true;
    });
}


// ── The grouping card renders, and derives names the way the host does ─────
describe('[10] platform-group rendering');
{
    // The section mounts this behind an async load, so a suite that never runs
    // effects would never reach it. It is exported for exactly this reason.
    // The default requireShim discards children (jsx: () => null), which is what
    // makes the RPC assertions easy but leaves nothing to walk. Re-instantiate
    // the factory against a VNode-preserving shim for this group only.
    const vnodeShim = spec => {
        if (spec === 'react') return reactStub;
        if (spec === 'react/jsx-runtime') {
            const make = (type, props, key) => ({ type, props: props ?? {}, key });
            return { jsx: make, jsxs: make, Fragment: 'Fragment' };
        }
        if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
        throw new Error(`unexpected seed word: ${spec}`);
    };
    const vnodeExports = captured.factory(vnodeShim);
    const PlatformGroup = vnodeExports.PlatformGroup;
    it('PlatformGroup is exported for isolated rendering', () => typeof PlatformGroup === 'function');

    // Minimal hook runtime: one render per call, state seeded from the first
    // useState argument. Enough to execute the component without react-dom.
    let cursor = 0;
    const hooks = [];
    const prevUseState = reactStub.useState;
    reactStub.useState = init => {
        const i = cursor++;
        if (hooks[i] === undefined) hooks[i] = typeof init === 'function' ? init() : init;
        return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }];
    };

    // Walk the returned VNode tree collecting element types and text.
    const collect = (node, seen, texts) => {
        if (node === null || node === undefined) return;
        if (typeof node === 'string') { texts.push(node); return; }
        if (typeof node === 'number') return;
        if (Array.isArray(node)) { for (const child of node) collect(child, seen, texts); return; }
        if (typeof node !== 'object') return;
        if (typeof node.type === 'function') seen.add(node.type.name || 'anonymous');
        else if (typeof node.type === 'string') seen.add(node.type);
        const props = node.props || {};
        for (const key of Object.keys(props)) {
            if (key === 'key' || key === 'type') continue;
            collect(props[key], seen, texts);
        }
    };

    const t = key => key;
    const noop = () => {};
    const base = { t, busy: false, onAddPlatform: noop, onAddAccount: noop, onRenamePlatform: noop, onRenameAccount: noop, onRemovePlatform: noop, onRemoveAccount: noop, onError: noop };

    const render = props => {
        cursor = 0;
        hooks.length = 0;
        const seen = new Set();
        const texts = [];
        collect(PlatformGroup({ ...base, ...props }), seen, texts);
        return { seen, texts };
    };

    const populated = render({
        groups: { platforms: [{ identifier: 'CF', label: 'Cloudflare' }], accounts: [{ platform: 'CF', identifier: 'WORK', label: 'Work' }] },
        keys: [{ name: 'DSH_CF_WORK_KEY' }],
    });
    it('renders without a hook error when populated', () => populated.seen.size > 0);
    it('renders the group container', () => eq(populated.texts.includes('kp-group'), true));
    it('renders the platform display name', () => eq(populated.texts.includes('Cloudflare'), true));
    it('renders the account display name', () => eq(populated.texts.includes('Work'), true));
    it('renders the id variable name for the account', () => eq(populated.texts.includes('$DSH_CF_WORK_ID'), true));
    it('renders the key variable name for the account', () => eq(populated.texts.includes('$DSH_CF_WORK_KEY'), true));

    const empty = render({ groups: { platforms: [], accounts: [] }, keys: [] });
    it('renders the empty state when there are no platforms', () => eq(empty.texts.includes('groupEmpty'), true));
    it('does not render a group container when empty', () => eq(empty.texts.includes('kp-group'), false));

    it('a platform whose label equals its identifier renders once', () => {
        const same = render({ groups: { platforms: [{ identifier: 'CF', label: 'CF' }], accounts: [] }, keys: [] });
        eq(same.texts.filter(x => x === 'CF').length, 1);
        return true;
    });

    // The splice must agree with the host, which owns the authoritative copy.
    it('isValidIdentifier accepts an uppercase identifier', () => eq(vnodeExports.isValidIdentifier('CF'), true));
    it('isValidIdentifier rejects lowercase', () => eq(vnodeExports.isValidIdentifier('cf'), false));
    it('isValidIdentifier rejects a leading digit', () => eq(vnodeExports.isValidIdentifier('1CF'), false));
    it('isValidIdentifier rejects a hyphen', () => eq(vnodeExports.isValidIdentifier('CLOUD-FLARE'), false));
    it('credentialName splices the id slot', () => eq(vnodeExports.credentialName('CF', 'WORK', 'id'), 'DSH_CF_WORK_ID'));
    it('credentialName splices the key slot', () => eq(vnodeExports.credentialName('CF', 'WORK', 'key'), 'DSH_CF_WORK_KEY'));
    it('the spliced name satisfies the host name grammar', () => eq(/^DSH_[A-Z][A-Z0-9_]*$/.test(vnodeExports.credentialName('CF', 'WORK', 'key')), true));

    // ── The usage card: two streams, shown not paired ──────────────────────
    const UsageCard = vnodeExports.UsageCard;
    it('UsageCard is exported for isolated rendering', () => typeof UsageCard === 'function');

    // Seed state rather than letting the effect run: the card loads
    // asynchronously and this suite has no effects.
    let preset = [];
    reactStub.useState = init => {
        const i = cursor++;
        if (hooks[i] === undefined) hooks[i] = preset[i] !== undefined ? preset[i] : (typeof init === 'function' ? init() : init);
        return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }];
    };
    const classes = [];
    const collect2 = node => {
        if (node === null || node === undefined) return;
        if (Array.isArray(node)) { for (const child of node) collect2(child); return; }
        if (typeof node !== 'object') return;
        if (typeof node.props?.className === 'string') classes.push(node.props.className);
        for (const key of Object.keys(node.props || {})) {
            if (key !== 'key' && key !== 'type') collect2(node.props[key]);
        }
    };
    const renderUsage = entries => {
        cursor = 0;
        hooks.length = 0;
        preset = [{ limit: 1000, total: entries.length, entries }];
        classes.length = 0;
        const seen = new Set();
        const texts = [];
        // ONE render, walked twice: a second call would start from a corrupted
        // hook cursor and report state the component never produced.
        const tree = UsageCard({ t, load: async () => ({}), limit: 200 });
        collect(tree, seen, texts);
        collect2(tree);
        return { seen, texts, classes };
    };

    const both = renderUsage([
        { t: 1_700_000_000_000, kind: 'intent', names: ['DSH_CF_WORK_KEY'], note: 'deploy staging' },
        { t: 1_700_000_001_000, kind: 'use', names: ['DSH_CF_WORK_KEY', 'DSH_GH_TOKEN'] },
    ]);
    it('renders a row per entry', () => eq(both.texts.filter(x => x === 'kp-usage-row').length >= 0, true));
    it('renders the declared tag for an intent', () => eq(both.texts.includes('usageSaid'), true));
    it('renders the handed tag for a use', () => eq(both.texts.includes('usageHanded'), true));
    it('the intent tag is styled apart from the use tag', () => eq(both.classes.includes('kp-usage-tag kp-usage-tag-said'), true));
    it('shows the intent note', () => eq(both.texts.includes('deploy staging'), true));
    it('shows every name in the entry', () => eq(both.texts.includes('$DSH_CF_WORK_KEY, $DSH_GH_TOKEN'), true));
    it('spells out the caveat about what a use means', () => eq(both.texts.includes('usageCaveat'), true));
    it('does not claim a use was a read', () => {
        // The wording is the whole point of D5. A row that said "used" would be
        // asserting something the host cannot observe.
        const wrong = both.texts.filter(x => typeof x === 'string' && /\bused\b/i.test(x) && !x.includes('usage'));
        eq(wrong, []);
        return true;
    });

    const none = renderUsage([]);
    it('renders the empty state with no entries', () => eq(none.texts.includes('usageEmpty'), true));

    // The card labels anything that is not an intent as "handed". It is NOT the
    // guard against unknown kinds — the host's readUsage() is, by filtering to
    // the two known kinds on the way out of the file. This asserts the split of
    // responsibility rather than pretending the component enforces it.
    it('the component treats a non-intent as a use; the host is the filter', () => {
        const odd = renderUsage([{ t: 1, kind: 'mystery', names: ['DSH_X'] }]);
        eq(odd.texts.includes('usageHanded'), true);
        return true;
    });
    it('the host drops unknown kinds before they can reach the card', async () => {
        const { readUsage } = await import(pathToFileURL(join(ROOT, 'lib', 'usage.js')).href);
        const probe = join(ROOT, 'test', '.usage-probe.jsonl');
        writeFileSync(probe, [
            JSON.stringify({ t: 1, kind: 'mystery', names: ['DSH_X'] }),
            JSON.stringify({ t: 2, kind: 'use', names: ['DSH_Y'] }),
            '',
        ].join('\n'));
        const entries = readUsage(probe);
        rmSync(probe, { force: true });
        eq(entries.map(e => e.kind), ['use']);
        return true;
    });

    reactStub.useState = prevUseState;
}


// ── The name-scope field is hidden in this release ─────────────────────────
describe('[11] the name-scope field is hidden');
{
    // The scope restriction ("the assistant may only touch DSH_AGENT_*") is not
    // shipping yet, so its entry point is hidden behind SHOW_SCOPE_UI in the
    // bundle. The capability underneath is untouched: policy.js still validates
    // and enforces a scope, the store still persists one, and the host suite
    // still covers all of it. This group protects the DELIBERATE omission — a
    // refactor that reinstates the field by accident, or a flag flipped before
    // the feature is ready, shows up here.
    //
    // The flag is read out of the bundle rather than restated, so the assertion
    // cannot drift from the code it describes.
    const flagOff = /const SHOW_SCOPE_UI = false;/.test(source);
    const flagOn = /const SHOW_SCOPE_UI = true;/.test(source);
    it('the bundle declares SHOW_SCOPE_UI exactly once',
        () => eq((source.match(/SHOW_SCOPE_UI = (?:true|false);/g) || []).length, 1));
    it('the scope field is guarded by the flag', () => eq(/SHOW_SCOPE_UI && jsx/.test(source), true));
    it('the dictionaries still carry the scope strings',
        () => eq(['scopeLabel:', 'scopeHint:'].every(k => source.includes(k)), true));

    // One render of the section, walked with a VNode harvester that descends
    // into function components. A function VNode is otherwise opaque, and the
    // card this test is about IS one.
    const vnodeShim2 = spec => {
        if (spec === 'react') return reactStub;
        if (spec === 'react/jsx-runtime') { const make = (type, props, key) => ({ type, props: props ?? {}, key }); return { jsx: make, jsxs: make, Fragment: 'Fragment' }; }
        if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
        throw new Error(`unexpected seed word: ${spec}`);
    };
    const ex2 = captured.factory(vnodeShim2);

    const harvest = (node, seen, texts, classes) => {
        if (node === null || node === undefined) return;
        if (typeof node === 'string') { texts.push(node); return; }
        if (typeof node === 'number') return;
        if (Array.isArray(node)) { for (const child of node) harvest(child, seen, texts, classes); return; }
        if (typeof node !== 'object') return;
        if (typeof node.type === 'function') {
            seen.add(node.type.name || 'anonymous');
            harvest(node.type(node.props || {}), seen, texts, classes);
            return;
        }
        if (typeof node.type === 'string') seen.add(node.type);
        const props = node.props || {};
        if (typeof props.className === 'string') classes.push(props.className);
        if (typeof props.placeholder === 'string') classes.push('PH:' + props.placeholder);
        for (const key of Object.keys(props)) {
            if (key === 'key' || key === 'type') continue;
            harvest(props[key], seen, texts, classes);
        }
    };

    // Hook slot 3 is the policy state. Seeding it is how the card is reached
    // without running effects, which this stub does not do.
    const seedPolicy = policy => {
        let cursor2 = 0;
        const hookStore = [];
        reactStub.useState = init => {
            const i = cursor2++;
            if (hookStore[i] === undefined) hookStore[i] = typeof init === 'function' ? init() : init;
            return [hookStore[i], value => { hookStore[i] = typeof value === 'function' ? value(hookStore[i]) : value; }];
        };
        hookStore[3] = policy;
        const seen = new Set(), texts = [], classes = [];
        harvest(ex2.KeyPanelSection({
            t: key => key,
            status: async () => ({}), list: async () => [], setKey: async () => {}, removeKey: async () => {}, revealKey: async () => {},
            // A scope IS set: if the field were only restyled away, the card
            // would still render something. Seeding a scope is the strict case.
            getPolicy: async () => policy, setPolicy: async () => ({}),
            groups: async () => ({ platforms: [], accounts: [] }),
            addPlatform: async () => {}, setPlatformLabel: async () => {}, removePlatform: async () => {},
            addAccount: async () => {}, setAccountLabel: async () => {}, removeAccount: async () => {},
            credentialNames: async () => [], usage: async () => ({ entries: [], total: 0, limit: 200 }),
        }), seen, texts, classes);
        return { seen, texts, classes };
    };

    const withScope = seedPolicy({ accessMode: 'edit', scopePattern: 'DSH_AGENT_*' });
    it('renders the access card itself', () => eq(withScope.texts.includes('policyTitle'), true));
    it('renders the mode choices', () => eq(withScope.classes.includes('kp-modes'), true));
    it('hides the scope label', () => eq(withScope.texts.includes('scopeLabel'), false));
    it('hides the scope hint', () => eq(withScope.texts.includes('scopeHint'), false));
    it('hides the scope input', () => eq(withScope.classes.includes('PH:DSH_AGENT_*'), false));
    it('hides the scope row', () => eq(withScope.classes.includes('kp-field'), false));
    it('keeps the edit-mode warning', () => eq(withScope.texts.includes('warnEdit'), true));

    it('the flag is off in this release', () => {
        eq(flagOff, true);
        eq(flagOn, false);
        return true;
    });
}


// ── Filling a key in FROM the account, not from the flat card ──────────────
describe('[13] filling a key in from the account row');
{
    // The gap this group protects: a platform and an account are created, and
    // the panel shows the two derived variable names — but nothing on the row
    // can put a VALUE into them. The operator had to carry a name the plugin
    // computed up to the flat "Add key" card and retype it, once per field.
    // That is transcription, not input, and it is what the popup removes.
    const vnodeShim3 = spec => {
        if (spec === 'react') return reactStub;
        if (spec === 'react/jsx-runtime') { const make = (type, props, key) => ({ type, props: props ?? {}, key }); return { jsx: make, jsxs: make, Fragment: 'Fragment' }; }
        if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
        throw new Error('unexpected seed word: ' + spec);
    };
    const ex3 = captured.factory(vnodeShim3);
    const PlatformGroup = ex3.PlatformGroup;

    // Executes the component for real, descending into function VNodes so the
    // Modal and its contents are reachable, recording every handler and value.
    const harvest = (node, out) => {
        if (node === null || node === undefined) return;
        if (typeof node === 'string') { out.texts.push(node); return; }
        if (typeof node === 'number') return;
        if (Array.isArray(node)) { for (const child of node) harvest(child, out); return; }
        if (typeof node !== 'object') return;
        // The primitives stub hands back a fresh () => null for every property
        // read, so a node.type === ex3.Modal identity check can never be true.
        // Identify the Modal by shape instead: the only node carrying an
        // 'open' flag together with a 'footer' array.
        if (node.props && node.props.open !== undefined && Array.isArray(node.props.footer)) out.modals.push(node.props);
        if (typeof node.type === 'function' && node.type.name) out.seen.add(node.type.name);
        if (typeof node.type === 'string') out.seen.add(node.type);
        const props = node.props || {};
        if (typeof props.className === 'string') out.classes.push(props.className);
        if (typeof props.value === 'string') out.values.push(props.value);
        if (typeof props.onClick === 'function') out.clicks.push(props.onClick);
        for (const key of Object.keys(props)) {
            if (key === 'key' || key === 'type' || key === 'onClick') continue;
            harvest(props[key], out);
        }
        // Only AFTER the props are walked: the stub renders every primitive as
        // () => null, so the output adds nothing here but would be lost if it
        // replaced the props walk. Kept so a real component still descends.
        if (typeof node.type === 'function') {
            harvest(node.type(props), out);
        }
    };

    // One render with a seeded hook store. Hook slot 5 is slotDraft — seeding it is
    // how the popup is reached without running the click that opens it.
    const render = (props, seed = {}, slotDraftSeed) => {
        let cursor = 0;
        const store = [];
        reactStub.useState = init => {
            const i = cursor++;
            if (store[i] === undefined) store[i] = typeof init === 'function' ? init() : init;
            return [store[i], value => { store[i] = typeof value === 'function' ? value(store[i]) : value; }];
        };
        if (slotDraftSeed !== undefined) store[5] = slotDraftSeed;
        const out = { seen: new Set(), texts: [], classes: [], values: [], clicks: [], modals: [] };
        harvest(PlatformGroup({
            t: key => key, busy: false,
            onAddPlatform: () => {}, onAddAccount: () => {}, onRenamePlatform: () => {}, onRenameAccount: () => {},
            onRemovePlatform: () => {}, onRemoveAccount: () => {}, onError: () => {},
            setKey: seed.setKey ?? (async () => {}),
            ...props,
        }), out);
        return { out, store };
    };

    const groups = { platforms: [{ identifier: 'CF', label: 'Cloudflare' }], accounts: [{ platform: 'CF', identifier: 'WORK', label: 'Work' }] };

    // ── The row tells you whether a slot is actually filled ────────────────
    const nothing = render({ groups, keys: [] });
    it('an empty slot is labelled as such', () => eq(nothing.out.texts.includes('slotEmpty'), true));
    it('an empty slot is not labelled as filled', () => eq(nothing.out.texts.includes('slotFilled'), false));

    const half = render({ groups, keys: [{ name: 'DSH_CF_WORK_KEY' }] });
    it('a slot that holds a value is labelled as filled', () => eq(half.out.texts.includes('slotFilled'), true));
    it('the other slot still reads as empty', () => eq(half.out.texts.includes('slotEmpty'), true));

    // ── The entry point lives on the account row ──────────────────────────
    it('the account row offers the fill entry point', () => eq(nothing.out.texts.includes('fillKey'), true));

    // ── The popup states the two names before anything is typed ────────────
    const open = render({ groups, keys: [] }, {}, { platform: 'CF', identifier: 'WORK', label: 'Work', id: '', key: '', error: null });
    it('the popup opens as a Modal', () => eq(open.out.modals.length, 1));
    it('the popup shows both derived names', () => {
        eq(open.out.texts.includes('DSH_CF_WORK_ID'), true);
        eq(open.out.texts.includes('DSH_CF_WORK_KEY'), true);
        return true;
    });
    it('the popup has one field per credential slot', () => eq(open.out.values.length, 2));
    it('the popup carries a save and a cancel', () => eq(open.out.modals[0].footer.length, 2));
    it('the footer exposes a save button', () => typeof open.out.modals[0].footer.find(b => b.key === 'save').props.onClick === 'function');

    // ── Saving files both values under the account ─────────────────────────
    // The slot is the whole point: it is what makes a key BELONG to the
    // account rather than merely happening to share its name.
    {
        const calls = [];
        const one = render({ groups, keys: [] }, { setKey: async (name, value, description, slot) => { calls.push({ name, value, slot }); } },
            { platform: 'CF', identifier: 'WORK', label: 'Work', id: '', key: 'tok-456', error: null });
        it('the popup does not write merely by rendering', () => eq(calls.length, 0));
        await one.out.modals[0].footer.find(b => b.key === 'save').props.onClick();
        it('a single filled slot writes exactly one key', () => eq(calls.length, 1));
        it('the write uses the derived name, never a typed one', () => eq(calls[0].name, 'DSH_CF_WORK_KEY'));
        it('the write is filed under the account', () => eq(calls[0].slot, { platform: 'CF', account: 'WORK', field: 'key' }));
    }

    {
        const calls = [];
        const both = render({ groups, keys: [] }, { setKey: async (name, value, description, slot) => { calls.push({ name, slot }); } },
            { platform: 'CF', identifier: 'WORK', label: 'Work', id: 'acct-123', key: 'tok-456', error: null });
        await both.out.modals[0].footer.find(b => b.key === 'save').props.onClick();
        it('both slots writes two keys', () => eq(calls.length, 2));
        it('the id slot is written first', () => eq(calls[0].name, 'DSH_CF_WORK_ID'));
        it('the key slot is written second', () => eq(calls[1].name, 'DSH_CF_WORK_KEY'));
    }

    // ── An all-blank submit is refused, not sent ───────────────────────────
    {
        const calls = [];
        const blank = render({ groups, keys: [] }, { setKey: async (...a) => { calls.push(a); } },
            { platform: 'CF', identifier: 'WORK', label: 'Work', id: '', key: '', error: null });
        await blank.out.modals[0].footer.find(b => b.key === 'save').props.onClick();
        it('an all-blank submit writes nothing', () => eq(calls.length, 0));
        it('an all-blank submit reports the refusal', () => eq(blank.store[5].error, 'fillNone'));
    }

    // ── A failed write surfaces rather than vanishing ──────────────────────
    {
        const boom = render({ groups, keys: [] }, { setKey: async () => { throw new Error('host refused'); } },
            { platform: 'CF', identifier: 'WORK', label: 'Work', id: 'acct-123', key: '', error: null });
        await boom.out.modals[0].footer.find(b => b.key === 'save').props.onClick();
        it('a refused write keeps the popup open', () => eq(boom.store[5] !== null, true));
        it('a refused write reports the reason', () => eq(String(boom.store[5].error).includes('host refused'), true));
    }

    // ── Half a pair: the first write lands, the second does not ────────────
    // The two writes are deliberately independent calls, so this is reachable:
    // the account ends up with one slot filled. The reports that matter are that
    // the successful write really happened (it must not be rolled back or
    // pretended away), that the popup stays open on the failure, and that the
    // failure names the endpoint that failed — the second one, not the first.
    {
        const calls = [];
        const half = render({ groups, keys: [] }, {
            setKey: async (name, value, description, slot) => {
                calls.push({ name, value, slot });
                if (name === 'DSH_CF_WORK_KEY') throw new Error('keyPanel.set: gateway/internal: second write refused');
            },
        }, { platform: 'CF', identifier: 'WORK', label: 'Work', id: 'acct-123', key: 'tok-456', error: null });
        await half.out.modals[0].footer.find(b => b.key === 'save').props.onClick();
        it('the first write reached the host', () => eq(calls.length, 2));
        it('the first write was the id slot', () => eq(calls[0].name, 'DSH_CF_WORK_ID'));
        it('the first write is not un-done by the second failing', () => eq(calls[0].value, 'acct-123'));
        it('the failing write is the second one', () => eq(calls[1].name, 'DSH_CF_WORK_KEY'));
        it('the popup stays open so the operator sees the half state', () => eq(half.store[5] !== null, true));
        it('the report names the endpoint that failed', () => eq(String(half.store[5].error).includes('keyPanel.set'), true));
        it('the report keeps the host code visible', () => eq(String(half.store[5].error).includes('gateway/internal'), true));
        it('the entered values are left in place for a retry', () => {
            eq(half.store[5].id, 'acct-123');
            eq(half.store[5].key, 'tok-456');
            return true;
        });
    }

    // ── The flat card is NOT removed ───────────────────────────────────────
    // Ungrouped keys have no account to be filled in from, so the flat entry
    // point has to stay. This asserts the popup was an ADDITION, not a move.
    it('the flat add-key entry point still exists', () => eq(source.includes('t("addKey")'), true));

    // ── The dictionaries carry the new strings ─────────────────────────────
    it('the new popup strings are defined', () => {
        for (const key of ['fillKey:', 'fillKeyTitle:', 'fillKeyLead:', 'slotId:', 'slotKey:', 'slotEmpty:', 'slotFilled:', 'slotKeepHint:', 'fillSave:', 'fillNone:']) {
            if (!source.includes(key)) throw new Error('missing dictionary key ' + key);
        }
        return true;
    });
}

describe('[12] every primitive the bundle destructures actually exists');
// The bundle pulls ~15 names out of @deepseek-ai/dsh-client-ui-primitives by
// destructuring. A name that does not exist is `undefined` — no import error,
// no lint warning — and the failure only appears when React tries to render it:
// "Element type is invalid", which blanks the WHOLE settings section.
//
// That is exactly how IconKey shipped: the host never exported it, the panel
// rendered an empty page, and every test still passed. The fix was one word;
// finding it took an afternoon. This group is the cheap version of that search.
//
// The list below is the host's real export surface (icons + the handful of
// components the bundle uses), captured from
// @deepseek-ai/dsh-client-ui-primitives 0.1.5-rc.2. It is public API, so it
// belongs in this repo. When the host adds icons this only ever grows — a name
// leaving the list would be a breaking host change worth noticing.
{
    const KNOWN_PRIMITIVES = new Set([
        // components / helpers
        'Button', 'Input', 'Tag', 'StateDot', 'Modal', 'Toast', 'writeClipboard',
        // icons
        'IconAgentPresetOutline16', 'IconAlarmClockOutline16', 'IconApiOutline14',
        'IconArchiveOutline20', 'IconBranchOutline16', 'IconBrowseOutline16',
        'IconCheckOutline14', 'IconCheckOutline16', 'IconChecklistOutline14',
        'IconChevronDownOutline14', 'IconChevronLeftOutline14',
        'IconChevronRightOutline14', 'IconChevronUpOutline14',
        'IconClockOutline16', 'IconCloseFill14', 'IconCloseOutline16',
        'IconCodeOutline16', 'IconContextInjectionOutline16', 'IconCopyOutline16',
        'IconCordisPluginOutline14', 'IconDarkOutline16', 'IconDataOutline16',
        'IconDatabaseOutline16', 'IconDislikeFill16', 'IconDislikeOutline16',
        'IconDownloadOutline16', 'IconEditOutline16', 'IconEllipsisOutline16',
        'IconEnhanceOutline16', 'IconFolderClose16', 'IconFolderOpen16',
        'IconFolderOpenOutline16', 'IconFollowsystemOutline16',
        'IconFullscreenOutline16', 'IconGaugeOutline16', 'IconGlobeOutline14',
        'IconGoalOutline16', 'IconInspectOutline12', 'IconLightOutline16',
        'IconLikeFill16', 'IconLikeOutline16', 'IconLinkOutline14',
        'IconLinkOutline16', 'IconListPenOutline16', 'IconLoadingOutline16',
        'IconNewChatOutline16', 'IconPanelLeftOutline16', 'IconPaperclipOutline16',
        'IconPauseOutline16', 'IconPersonalizationOutline16', 'IconPlayOutline16',
        'IconPlusOutline16', 'IconProjectAddOutline16', 'IconQuestionOutline14',
        'IconQueueOutline14', 'IconRefreshOutline14', 'IconRefreshOutline16',
        'IconRightUpOutline14', 'IconRightUpOutline16', 'IconSearchOutline16',
        'IconSendOutline14', 'IconSendOutline16', 'IconSettingsOutline14',
        'IconSettingsOutline16', 'IconShareOutline16', 'IconSkillOutline16',
        'IconSparkle16', 'IconStopFill16', 'IconThinkOutline14',
        'IconThinkOutline16', 'IconTrashOutline16', 'IconTreeCorner8x10',
        'IconTriangleRightFill14', 'IconUserOutline16', 'IconWarningOutline16',
    ]);

    // Pull the destructure list straight out of the bundle so this cannot drift:
    // if someone adds a name to the destructure and not to the list above, the
    // assertion below fails.
    const destructured = (() => {
        // Anchor on the LAST `} = primitives;` and take the brace block that
        // opens right before it. A plain non-greedy match starts at the first
        // `const {` in the file — which is the react/jsx-runtime one — and
        // swallows both destructures.
        const end = source.lastIndexOf('} = primitives;');
        if (end === -1) throw new Error('could not find the primitives destructure');
        const open = source.lastIndexOf('const {', end);
        if (open === -1) throw new Error('could not find the destructure opening brace');
        const inner = source.slice(source.indexOf('{', open) + 1, end);
        return inner.split(',').map(s => s.trim()).filter(s => s !== '');
    })();

    it('the destructure list was found and is non-trivial', () => destructured.length >= 10);
    it('no unknown name is destructured from the primitives', () => {
        const unknown = destructured.filter(n => !KNOWN_PRIMITIVES.has(n));
        eq(unknown, []);
        return true;
    });
}
// ── Every client payload matches the host descriptor it will meet ──────────
describe('[23] every client RPC payload matches the host descriptor');
// The gap that let the filled-in-from-an-account popup break in production.
//
// Typert derives a remote's wire fields from the HOST METHOD'S PARAMETER NAMES
// (methodParameterNames, via Function.prototype.toString) and then
// assertExactArguments rejects any payload carrying a key the descriptor does
// not list, or missing one it does. The client half and the host half were each
// tested against their own assumption — the client suite stubbed rpc.call to
// return {ok:true} for anything — so nothing compared the two.
//
// This group does that comparison for real. It reads the parameter names off
// the ACTUAL host gateway (never a list restated here, which would be circular)
// and replays the panel's own calls against them.
{
    // The host half is a plain ESM module; import it exactly as the app does.
    const host = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href);
    const { KeyPanelGateway } = host;

    // Transcribed from the gateway's own methodParameterNames().
    const wireFields = (name) => {
        const fn = KeyPanelGateway.prototype[name];
        if (typeof fn !== 'function') throw new Error(`host gateway has no method ${name}`);
        const src = Function.prototype.toString.call(fn);
        const open = src.indexOf('(');
        const close = src.indexOf(')', open + 1);
        const body = src.slice(open + 1, close).trim();
        return body.length === 0 ? [] : body.split(',').map(s => s.trim());
    };

    // Transcribed from the gateway's own assertExactArguments().
    const mismatch = (args, expected) => {
        const extra = Object.keys(args).filter(k => !expected.includes(k));
        const missing = expected.filter(k => !Object.hasOwn(args, k));
        if (extra.length === 0 && missing.length === 0) return null;
        const clauses = [];
        if (missing.length > 0) clauses.push(`missing ${missing.map(k => JSON.stringify(k)).join(', ')}`);
        if (extra.length > 0) clauses.push(`unexpected ${extra.map(k => JSON.stringify(k)).join(', ')}`);
        return `args fields do not match the descriptor: ${clauses.join('; ')}`;
    };

    it('the gateway exposes its remote methods to check', () => typeof KeyPanelGateway.prototype.set === 'function');

    // Replay the panel's whole call surface, exactly as the section issues it.
    const seen = [];
    const ctx23 = makeCtx(async (channel, endpoint, payload) => {
        const method = endpoint.startsWith('keyPanel/') ? endpoint.slice('keyPanel/'.length) : null;
        if (method !== null) seen.push({ method, args: payload.args });
        return { ok: true, value: {} };
    });
    registered = null;
    const ex23 = captured.factory(requireShim);
    ex23.apply(ctx23);
    const api23 = registered.options.inject();

    await api23.list();
    await api23.status();
    await api23.setKey('DSH_X', 'v', 'd');
    await api23.setKey('DSH_CF_WORK_KEY', 'v', 'd', { platform: 'CF', account: 'WORK', field: 'key' });
    await api23.removeKey('DSH_X');
    await api23.revealKey('DSH_X');
    await api23.getPolicy();
    await api23.setPolicy('edit', 'DSH_AGENT_*');
    await api23.groups();
    await api23.addPlatform('CF', 'Cloudflare');
    await api23.setPlatformLabel('CF', 'Cloudflare Inc');
    await api23.removePlatform('CF', true);
    await api23.addAccount('CF', 'WORK', 'Work');
    await api23.setAccountLabel('CF', 'WORK', 'Work acct');
    await api23.removeAccount('CF', 'WORK', true);
    await api23.credentialNames('CF', 'WORK');
    await api23.usage();

    // Map each client call to the host method it targets.
    const HOST_METHOD = {
        list: 'list', status: 'status', set: 'set', remove: 'remove', reveal: 'reveal',
        getPolicy: 'getPolicy', setPolicy: 'setPolicy', groups: 'groups',
        addPlatform: 'addPlatform', setPlatformLabel: 'setPlatformLabel', removePlatform: 'removePlatform',
        addAccount: 'addAccount', setAccountLabel: 'setAccountLabel', removeAccount: 'removeAccount',
        credentialNames: 'credentialNames', usage: 'usage',
    };

    const offenders = [];
    for (const call of seen) {
        const hostMethod = HOST_METHOD[call.method];
        if (hostMethod === undefined) continue;
        const bad = mismatch(call.args, wireFields(hostMethod));
        // Report the offending METHOD, not the payload: a failure message that
        // prints the args would put a secret in the suite's output.
        if (bad !== null) offenders.push(`${call.method}: ${bad}`);
    }
    it('no client payload carries a field the host descriptor does not list', () => {
        eq(offenders, []);
        return true;
    });

    it('every remote the panel calls actually exists on the gateway', () => {
        const absent = [...new Set(seen.map(c => c.method))].filter(m => typeof KeyPanelGateway.prototype[HOST_METHOD[m] ?? m] !== 'function');
        eq(absent, []);
        return true;
    });

    // The regression itself, pinned by name. Losing this one line is what made
    // the whole fill-in-from-an-account flow unsavable.
    it('set() takes the slot as ONE parameter, not three spread fields', () => {
        eq(wireFields('set'), ['keyName', 'value', 'description', 'slot']);
        return true;
    });
}

// ── [24] the bundle body did not lose its shape ──────────────────────────────
//
// A structural defect this suite could not see: a doc comment whose statement
// was deleted, left stacked against the next declaration, and a run of
// declarations that had been dedented out of their block. Both are invisible to
// every assertion above — the factory still parses, still exports, still
// renders — yet they are unambiguous damage in a repo whose whole point is that
// `lib/` IS the shipped source. Rendering cannot catch them and neither could
// the RPC contract, so the shape is asserted directly.
{
    const body = source.slice(source.indexOf('{', source.indexOf('window.__ModuleLoader__.load')));

    it('no doc comment is left with no statement under it', () => {
        // A `/** ... */` comment immediately followed by another `/**` means the
        // declaration the first one described is gone. Comments may document each
        // other only in the `//` style, never as two block comments in a row.
        const stacked = /\/\*\*[\s\S]*?\*\/\s*\/\*\*/.test(body);
        eq(stacked, false);
        return true;
    });

    it('no declaration is dedented out of its enclosing block', () => {
        // Anchored on the ENCLOSING FUNCTION's body indent, which is the only
        // thing that can see the defect at all.
        //
        // Why nothing local works: the collapsed run was self-consistent — it
        // opened `[` and closed `]` at the same indent, and every line of the run
        // shared one level. So an opener/closer check, a brace-depth check and a
        // neighbour comparison ALL stay silent on it. Two earlier versions of this
        // test were written that way and each passed on the deliberately broken
        // file; both were replaced. The only reference that is not part of the
        // damaged run is the function body CONTAINING it.
        //
        // So: for each `function NAME(...) {` in the bundle, take the indent of its
        // first statement as the body's true level, then require that every
        // statement inside that function sits at that level or deeper. A run that
        // has been shifted out of the body — the actual bug — is shallower than it,
        // and is caught. Measured on the real file, this reports zero offenders.
        const stripped = body
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

        const lines = stripped.split('\n');
        const offenders = [];

        // Indent expected inside each open function body, innermost last.
        const expected = [];
        let pendingFunction = null;

        for (let i = 0; i < lines.length; i += 1) {
            const raw = lines[i];
            const trimmed = raw.trim();
            if (trimmed === '') continue;
            const indent = raw.match(/^\t*/)[0].length;

            // A function header opens a body whose level is set by its first
            // statement, not by assumption.
            if (/^(?:function\s+\w+|\w+\s*:\s*function)/.test(trimmed) && /\{\s*$/.test(trimmed)) {
                pendingFunction = { headerLine: i + 1, headerIndent: indent, body: null };
                expected.push(pendingFunction);
                continue;
            }

            if (pendingFunction !== null && pendingFunction.body === null) {
                // First statement of the body defines its true indent.
                pendingFunction.body = indent;
                pendingFunction = null;
            }

            const enclosing = expected.length > 0 ? expected[expected.length - 1] : null;
            if (enclosing !== null && enclosing.body !== null) {
                // A standalone closer at the body's own level is fine; anything
                // shallower than the body while not being the closing brace is a
                // statement that escaped its block.
                const isCloser = /^\}/.test(trimmed);
                if (indent < enclosing.body && !isCloser && indent <= enclosing.headerIndent) {
                    offenders.push(`line ${i + 1}: "${trimmed.slice(0, 34)}" at ${indent} tabs, inside a body at ${enclosing.body} (function at ${enclosing.headerLine})`);
                }
            }

            // Close the innermost function when its own brace returns to header level.
            if (enclosing !== null && isCloserFor(trimmed) && indent === enclosing.headerIndent) {
                expected.pop();
            }
        }

        function isCloserFor(t) { return t === '}' || t.startsWith('},') || t.startsWith('});'); }

        eq(offenders, []);
        return true;
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);