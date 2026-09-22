/**
 * @moruteaven/dsh-key-panel — host half.
 *
 * Two faces, deliberately separated:
 *
 *  1. A READ-ONLY contribution to the model's shell environment. Every stored
 *     key is declared with `ctx.shellEnv` and resolved per shell execution, so
 *     the model can write `curl -H "Authorization: Bearer $DSH_CF_TOKEN"` and
 *     the host substitutes the value. The model never sees the secret, so it
 *     never enters the transcript.
 *
 *  2. An OPERATOR-governed management surface. The settings page can always do
 *     anything. The model gets tools only in the modes the operator selects,
 *     and every mutation is checked against the persisted policy before it
 *     touches the store.
 *
 * Why plaintext rather than an encrypted vault: a vault needs its password at
 * boot, and a missing password makes `apply()` throw, which takes down the
 * whole plugin tree and lands the app in recovery mode. That failure mode is
 * real and was observed on this machine. Plaintext trades confidentiality at
 * rest for a plugin that cannot fail to start. See SECURITY.md.
 *
 * Security posture summary (details in SECURITY.md):
 *  - The model never reads a value through a tool; only the shell env carries
 *    values, and only into the shell the host itself invokes.
 *  - Destructive model calls require a confirmation token round-trip, so a
 *    single hallucinated call cannot silently delete a credential.
 *  - The policy lives in the store file, outside the model's reach.
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { KeyStore, keyStorePath, isValidKeyName, credentialName, FIELD_ID, FIELD_KEY, ORIGIN_MODEL, ORIGIN_OPERATOR } from './store.js';
import { checkModelAccess, normalisePolicy, isAccessMode, normaliseScopePattern, ACCESS_MODES } from './policy.js';
import { registerModelTools, ConfirmationLedger } from './tools.js';
import { UsageLog, usageLogPath, readUsage, KIND_USE, KIND_INTENT } from './usage.js';

export const name = 'key-panel';
export const inject = ['shellEnv', 'tools'];

/** Descriptor key the Typert gateway reads during source-mode discovery. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * Mark public instance methods as Typert Remote endpoints without decorators.
 *
 * The `@Remote('x')` decorator is sugar over exactly this: it appends
 * `{ method, invocation: { kind: 'direct' } }` markers to a frozen descriptor
 * stored on the prototype. Writing it by hand keeps this plugin a plain
 * single-file ES module — no TypeScript build step, no code generation, and no
 * `--experimental-decorators` flag.
 *
 * @param {Function} ctor - gateway class whose prototype carries the methods.
 * @param {string[]} methods - public instance method names to expose.
 */
function markRemoteMethods(ctor, methods) {
    const existing = ctor.prototype[REMOTE_METHOD_DESCRIPTOR];
    const markers = methods.map(method => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }));
    Object.defineProperty(ctor.prototype, REMOTE_METHOD_DESCRIPTOR, {
        configurable: true,
        value: Object.freeze({ version: 1, methods: Object.freeze([...existing?.methods ?? [], ...markers]) }),
    });
}

/** Redact a value for display: keep a short head and tail, hide the middle. */
export function maskValue(value) {
    if (value.length <= 12) return '•'.repeat(value.length);
    return `${value.slice(0, 4)}${'•'.repeat(Math.min(value.length - 8, 24))}${value.slice(-4)}`;
}

/**
 * Remote gateway backing the settings page. Every method here is reachable
 * only from the DSH settings UI (loopback-trusted), never from the model.
 *
 * Holds the live registry handle so a mutation re-declares newly added names
 * immediately — the registry validates declared names up front, so a key added
 * through the page must be declared before it can carry a value.
 */
class KeyPanelGateway extends TypertRemoteService {
    /**
     * @param {import('@deepseek-ai/cordis').Context} ctx
     * @param {{store: KeyStore, filePath: string, usagePath: string, usage: UsageLog, resync: () => void, retool: () => void, logger?: object}} deps
     */
    constructor(ctx, deps) {
        super(ctx, 'keyPanel');
        this.store = deps.store;
        this.filePath = deps.filePath;
        this.usage = deps.usage;
        this.usagePath = deps.usagePath;
        this.resync = deps.resync;
        this.retool = deps.retool;
        this.logger = deps.logger;
    }

    /** Masked rows for the settings page: never carries a value. */
    list() {
        return this.store.list().map(({ name, description, origin, platform, account, field, createdAt, updatedAt }) => ({
            name,
            description,
            origin,
            // Grouping passes through only when the store resolved it, so a key
            // whose platform vanished arrives here without a stale reference
            // and the panel files it under "ungrouped".
            ...(platform === undefined ? {} : { platform, account, field }),
            createdAt,
            updatedAt,
            masked: '••••••••',
        }));
    }

    /** One key's metadata plus a redacted preview. */
    describe(keyName) {
        const found = this.#find(keyName);
        return {
            name: found.name,
            description: found.description,
            origin: found.origin,
            ...(found.platform === undefined ? {} : { platform: found.platform, account: found.account, field: found.field }),
            masked: maskValue(found.value),
            length: found.value.length,
            createdAt: found.createdAt,
            updatedAt: found.updatedAt,
        };
    }

    /** Explicit plaintext reveal — the operator pressed "show". */
    reveal(keyName) {
        const found = this.#find(keyName);
        return { name: found.name, value: found.value };
    }

    /**
     * Create or replace one key. Returns the redacted record.
     *
     * @param {string} keyName - the full variable name.
     * @param {string} value - the secret.
     * @param {string} description - non-blank description.
     * @param {{ platform?: string, account?: string, field?: string }} [slot] -
     *        credential slot this key fills. Omit it to leave the key ungrouped;
     *        on an already-filed key, omitting it KEEPS the existing filing.
     */
    set(keyName, value, description, slot) {
        if (!isValidKeyName(keyName)) {
            throw new Error(`invalid name "${keyName}"; use a DSH_ prefix and A-Z / 0-9 / _ only`);
        }
        this.store.set(keyName, value, description, { origin: ORIGIN_OPERATOR, ...(slot ?? {}) });
        this.resync();
        this.logger?.info?.(`dsh-key-panel: stored ${keyName} (${this.store.names().length} total)`);
        return this.describe(keyName);
    }

    // ── Platforms and accounts ───────────────────────────────────────────────

    /** Every platform and account, for the panel's grouping view. */
    groups() {
        return {
            platforms: this.store.platforms(),
            accounts: this.store.accounts(),
        };
    }

    /**
     * Create a platform.
     *
     * @param {string} identifier - spliced into variable names, e.g. "CF".
     * @param {string} [label] - display name; defaults to the identifier.
     */
    addPlatform(identifier, label) {
        const entry = this.store.addPlatform(identifier, { label });
        this.logger?.info?.(`dsh-key-panel: added platform ${identifier}`);
        return entry;
    }

    /** Rename a platform's display label. The identifier is immutable (D10). */
    setPlatformLabel(identifier, label) {
        return this.store.setPlatformLabel(identifier, label);
    }

    /**
     * Remove a platform.
     *
     * @param {string} identifier - platform to remove.
     * @param {boolean} [force] - when true, un-file the platform's keys instead
     *        of refusing. Their values are never touched; only the grouping is
     *        cleared, so nothing secret is lost by this call.
     */
    removePlatform(identifier, force) {
        const result = this.store.removePlatform(identifier, { force: force === true });
        if (result.removed) {
            // Un-filing changes descriptions' association but not the key set,
            // so the registry needs no rebuild — resync anyway to keep one code
            // path, since it is cheap and idempotent.
            this.resync();
            this.logger?.info?.(`dsh-key-panel: removed platform ${identifier} (un-filed ${result.unfiled.length})`);
        }
        return result;
    }

    /** Add an account under a platform. */
    addAccount(platform, identifier, label) {
        const entry = this.store.addAccount(platform, identifier, { label });
        this.logger?.info?.(`dsh-key-panel: added account ${platform}/${identifier}`);
        return entry;
    }

    /** Rename an account's display label. */
    setAccountLabel(platform, identifier, label) {
        return this.store.setAccountLabel(platform, identifier, label);
    }

    /**
     * Remove an account.
     *
     * @param {string} platform - owning platform identifier.
     * @param {string} identifier - account identifier.
     * @param {boolean} [force] - un-file its keys instead of refusing.
     */
    removeAccount(platform, identifier, force) {
        const result = this.store.removeAccount(platform, identifier, { force: force === true });
        if (result.removed) {
            this.resync();
            this.logger?.info?.(`dsh-key-panel: removed account ${platform}/${identifier} (un-filed ${result.unfiled.length})`);
        }
        return result;
    }

    /**
     * The variable names a credential slot maps to.
     *
     * The panel shows these before the operator commits, so they can see exactly
     * what will end up in the shell — and so a name they already use is spotted
     * before it is overwritten rather than after.
     */
    credentialNames(platform, account) {
        return {
            id: credentialName(platform, account, FIELD_ID),
            key: credentialName(platform, account, FIELD_KEY),
        };
    }

    /** Remove one key. */
    remove(keyName) {
        const removed = this.store.remove(keyName);
        if (removed) this.resync();
        this.logger?.info?.(`dsh-key-panel: removed ${keyName} (${this.store.names().length} remaining)`);
        return { removed, remaining: this.store.names().length };
    }

    /** The operator's access policy. */
    getPolicy() {
        return this.store.policy();
    }

    /** Set the operator's access policy. */
    setPolicy(accessMode, scopePattern) {
        if (!isAccessMode(accessMode)) {
            throw new Error(`unknown access mode "${String(accessMode)}"; expected one of ${ACCESS_MODES.join(', ')}`);
        }
        const policy = this.store.setPolicy({ accessMode, scopePattern: normaliseScopePattern(scopePattern ?? null) });
        // Re-derive the model's tool surface immediately: raising or lowering
        // the mode must take effect on the next turn, not the next restart.
        this.retool();
        this.logger?.info?.(`dsh-key-panel: access mode -> ${policy.accessMode}${policy.scopePattern === null ? '' : ` (scope ${policy.scopePattern})`}`);
        return policy;
    }

    /** Where the store lives, and what the model can actually reach. */
    status() {
        const names = this.store.names();
        const policy = this.store.policy();
        const platforms = this.store.platforms();
        return {
            storePath: this.filePath,
            count: names.length,
            names,
            // Grouping counts are reported alongside the flat list on purpose:
            // the flat names are what the shell actually sees, and the counts
            // are only there to explain the panel's shape. Reporting one without
            // the other invites the reader to think the namespace became nested.
            platformCount: platforms.length,
            accountCount: this.store.accounts().length,
            ungroupedCount: names.length - platforms.reduce((total, p) => total + this.store.namesIn(p.identifier).length, 0),
            policy,
            modeDescription: MODE_DESCRIPTIONS[policy.accessMode] ?? MODE_DESCRIPTIONS.readonly,
            injectHint: names.length === 0
                ? '还没有密钥。添加后，助手就能在 shell 命令中用 $<名称> 引用它。'
                : `助手可在 shell 中使用：${names.map(n => `$${n}`).join('、')}`,
        };
    }

    /**
     * Both usage streams, newest first, for the panel's history view.
     *
     * Flushes first so the view includes commands run seconds ago. The two
     * kinds are returned in ONE array, each entry tagged, rather than as a
     * pre-joined pairing: the panel aligns them by timestamp for display, and
     * the host stays out of the business of guessing which intent belongs to
     * which use. See lib/usage.js for why that guess is not made here.
     *
     * Flushing on read is also what keeps the buffer from being invisible to
     * an operator who only ever opens the panel.
     *
     * The signature takes NO parameters on purpose, and the reason is worth
     * spelling out because the failure is so quiet.
     *
     * Typert discovers remotes by reading the SOURCE, and it is strict about
     * parameter shape: a default, a destructure or a rest is rejected outright
     * with gateway/signature-invalid, and the method is then simply absent from
     * the callable set. That rejection is per-method, so the panel still mounts,
     * every other remote still answers, and the only symptom is one card sitting
     * in its empty state.
     *
     * Do NOT restate the offending signature shape in this comment. The source
     * scan reads comments too, and a parameter list written here is enough to
     * bring the rejection back. That mistake cost two debugging rounds; if the
     * shape needs documenting, describe it in prose in design-notes instead.
     *
     * Returning a fixed window is the honest shape anyway: the cap below is the
     * log's own retention limit, and a caller-chosen window would be a second,
     * invisible cap layered on top of it.
     */
    usage() {
        this.usage?.flush?.();
        const entries = readUsage(this.usagePath);
        return {
            usagePath: this.usagePath,
            limit: this.usage.limit,
            total: entries.length,
            // Newest first: a history view is read from the top.
            entries: entries.slice(-this.usage.limit).reverse(),
        };
    }

    #find(keyName) {
        const found = this.store.get(keyName);
        if (found === undefined) throw new Error(`unknown key "${keyName}"`);
        return found;
    }
}

/** Operator-facing copy for each mode, kept beside the enum it describes. */
const MODE_DESCRIPTIONS = Object.freeze({
    readonly: '只读 —— 助手只能用密钥，不能新增、修改或删除',
    write: '可写 —— 助手能新增密钥，并能更新它自己创建的密钥；不能删除、不能改你的密钥',
    edit: '可编辑 —— 助手能新增、修改、删除（删除仍需确认）',
});

markRemoteMethods(KeyPanelGateway, [
    // Key operations.
    'list', 'describe', 'reveal', 'set', 'remove', 'usage',
    // Policy.
    'getPolicy', 'setPolicy', 'status',
    // Grouping. A method missing from this list is unreachable from the panel,
    // and the omission is silent — the call simply never arrives.
    'groups', 'addPlatform', 'setPlatformLabel', 'removePlatform',
    'addAccount', 'setAccountLabel', 'removeAccount', 'credentialNames',
]);

export function apply(ctx, config = {}) {
    const dshHome = resolveDshHome(config.dshHome);
    const filePath = config.storePath ?? keyStorePath(dshHome);
    const usagePath = config.usagePath ?? usageLogPath(dshHome);
    const usage = new UsageLog(usagePath);
    const store = new KeyStore(filePath);

    ctx.logger?.info?.(`dsh-key-panel: loaded ${store.names().length} key(s) from ${filePath} (mode ${store.policy().accessMode})`);

    // ── Shell environment contribution ───────────────────────────────────────
    // The registry rebuilds the DSH_* namespace on every model shell call, so a
    // key added via the panel reaches the very next command with no restart.
    // `variables` must be declared up front; `resolve` supplies live values.
    let registration = null;

    const resync = () => {
        registration?.();
        registration = null;
        const descriptions = store.descriptions();
        const owned = Object.keys(descriptions);
        if (owned.length === 0) return;
        registration = ctx.shellEnv.register({
            name: 'key-panel',
            variables: Object.fromEntries(owned.map(k => [k, { description: descriptions[k] }])),
            // The one place this plugin observes a command actually running.
            //
            // Recorded names are the ones and only the ones being handed over
            // right now — read off the object just built, not off the declared
            // set, because those differ whenever a name is declared without a
            // usable value.
            //
            // The value is never recorded, and record() cannot throw. A log
            // line is not worth failing a shell command the model is waiting
            // on, and it is certainly not worth a secret in the file.
            resolve: () => {
                const values = store.values();
                usage.record(KIND_USE, Object.keys(values));
                return values;
            },
        });
    };
    resync();

    ctx.effect(() => () => {
        registration?.();
        registration = null;
        // Flush on teardown so the last batch survives a clean shutdown. A hard
        // kill still loses up to one interval — accepted, it is a log.
        usage.flush();
    });

    // ── Model-facing tools ───────────────────────────────────────────────────
    // Rebuilt whenever the policy changes. In `readonly` this registers
    // nothing at all, so the capability is genuinely absent from the model's
    // tool list rather than present-and-refusing.
    const ledger = new ConfirmationLedger();
    const record = (kind, names, extra) => usage.record(kind, names, extra);
    let disposeTools = registerModelTools({ ctx, store, resync, ledger, record });

    const retool = () => {
        disposeTools?.();
        disposeTools = registerModelTools({ ctx, store, resync, ledger, record });
        // A mode change invalidates outstanding delete confirmations: the
        // authority that justified them may no longer exist.
        ledger.pending.clear();
    };

    ctx.effect(() => () => {
        disposeTools?.();
        disposeTools = null;
    });

    // ── Settings gateway ─────────────────────────────────────────────────────
    ctx.plugin(KeyPanelGateway, { store, filePath, usagePath, usage, resync, retool, logger: ctx.logger });
}

export { KeyStore, keyStorePath, isValidKeyName, KeyPanelGateway, ORIGIN_MODEL, ORIGIN_OPERATOR };
export { checkModelAccess, normalisePolicy, ACCESS_MODES };
export { ConfirmationLedger } from './tools.js';
export { UsageLog, readUsage, usageLogPath, KIND_USE, KIND_INTENT, USAGE_LIMIT } from './usage.js';
export default { name, inject, apply };
