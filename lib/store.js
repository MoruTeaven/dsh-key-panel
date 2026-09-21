/**
 * Key storage for @moruteaven/dsh-key-panel.
 *
 * Secrets live in a single JSON document under the DSH home. Writes are
 * atomic (tmp + fsync + rename) and the file is chmod-ed 0600 where the
 * platform honours it; on Windows the file inherits the user-profile ACL,
 * which is the same protection the DSH home itself relies on.
 *
 * Shape:
 *   {
 *     version: 2,
 *     policy: { accessMode: "readonly", scopePattern: null },
 *     platforms: {
 *       "CF": { label: "Cloudflare", createdAt: 0 }
 *     },
 *     accounts: {
 *       "CF/WORK": { platform: "CF", identifier: "WORK", label: "Work", createdAt: 0 }
 *     },
 *     keys: {
 *       "DSH_CF_WORK_KEY": {
 *         value: "...",
 *         description: "...",
 *         origin: "operator" | "model",
 *         platform: "CF",
 *         account: "WORK",
 *         field: "id" | "key",
 *         createdAt: 0,
 *         updatedAt: 0
 *       }
 *     }
 *   }
 *
 * `origin` records who created a key. The "write" access mode lets the model
 * replace only keys it created itself, so provenance has to be durable rather
 * than derived. Records written before this field existed have no `origin` and
 * are treated as operator-owned, which is the conservative reading.
 *
 * `platform` / `account` / `field` are optional grouping metadata, added in
 * version 2. They record which credential slot a key belongs to; the variable
 * name stays the full name, so nothing about injection or policy changed.
 * Records without them are simply ungrouped, which is why version 1 files load
 * with no migration.
 *
 * TWO VALIDATION STYLES, ON PURPOSE:
 *   `keys` is validated strictly — a malformed entry throws. `platforms` and
 *   `accounts` degrade silently — a malformed entry is dropped.
 *   The difference is what a bad entry costs you. A bad key entry means a secret
 *   may have been lost or altered, and starting up silently would let the
 *   operator believe it is still there. A bad grouping entry costs you a label;
 *   the secrets themselves are untouched. Losing a label beats bricking the
 *   plugin (`apply()` throwing takes the app into recovery mode), so the
 *   grouping tables are read defensively.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalisePolicy, validatePolicyInput, ACCESS_MODE_FIELD, SCOPE_PATTERN_FIELD } from './policy.js';

export const STORE_VERSION = 2;

/** Variable-name grammar enforced by the shell-env registry: `DSH_` + [A-Z0-9_]+. */
export const KEY_NAME_PATTERN = /^DSH_[A-Z][A-Z0-9_]*$/;

/**
 * Grammar for a platform or account identifier.
 *
 * Identifiers are spliced into variable names, so they have to be legal inside
 * one: uppercase letters, digits and underscore, starting with a letter. No
 * hyphens, no spaces, no lowercase — a platform called "Cloudflare-Work" cannot
 * produce a usable variable name, so it is rejected at the point of entry
 * rather than silently upper-cased into a different identifier.
 */
export const IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Which credential slot a key fills. Only two today; see D9. */
export const FIELD_ID = 'id';
export const FIELD_KEY = 'key';
export const KEY_FIELDS = [FIELD_ID, FIELD_KEY];

/** Who created a key. */
export const ORIGIN_OPERATOR = 'operator';
export const ORIGIN_MODEL = 'model';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Validate a variable name against the registry grammar. */
export function isValidKeyName(name) {
    return typeof name === 'string' && KEY_NAME_PATTERN.test(name);
}

/** Validate a platform or account identifier. */
export function isValidIdentifier(value) {
    return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

/** Validate a credential slot. */
export function isValidField(value) {
    return value === FIELD_ID || value === FIELD_KEY;
}

/** Composite key for the accounts table: one account lives under one platform. */
export function accountKey(platform, account) {
    return `${platform}/${account}`;
}

/**
 * The variable name a credential slot maps to.
 *
 *   credentialName('CF', 'WORK', 'id')  -> 'DSH_CF_WORK_ID'
 *   credentialName('CF', 'WORK', 'key') -> 'DSH_CF_WORK_KEY'
 *
 * This is the whole integration point between the grouping model and the
 * registry: the name is a plain concatenation, so the shell-env namespace stays
 * flat and everything downstream (policy scoping, provenance, injection) keeps
 * working on full names without knowing a platform exists.
 *
 * Throws on anything outside the identifier grammar rather than sanitising,
 * because sanitising would silently produce a name the operator did not ask
 * for — and unlike a label, a variable name is an API other tooling relies on.
 */
export function credentialName(platform, account, field) {
    if (!isValidIdentifier(platform)) {
        throw new Error(`invalid platform identifier "${platform}"; must match ${String(IDENTIFIER_PATTERN)}`);
    }
    if (!isValidIdentifier(account)) {
        throw new Error(`invalid account identifier "${account}"; must match ${String(IDENTIFIER_PATTERN)}`);
    }
    if (!isValidField(field)) {
        throw new Error(`invalid field "${field}"; must be one of ${KEY_FIELDS.join(', ')}`);
    }
    return `DSH_${platform}_${account}_${field.toUpperCase()}`;
}

/** Validate a key record's description: required, non-blank (the registry demands it). */
export function normaliseDescription(value) {
    if (typeof value !== 'string') throw new Error('description must be a string');
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new Error('description must not be blank (the shell-env registry requires it)');
    return trimmed;
}

/** Reject a secret value that is blank. Whitespace inside a key is always a mistake. */
export function normaliseValue(value) {
    if (typeof value !== 'string') throw new Error('value must be a string');
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new Error('value must not be blank');
    return trimmed;
}

/**
 * Read the platforms table, dropping anything malformed.
 *
 * Returns a plain object keyed by identifier. Never throws: a corrupt platform
 * table costs the operator their grouping, not their secrets, and refusing to
 * start over it would take the whole app into recovery mode.
 */
export function normalisePlatforms(raw) {
    const out = {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [identifier, record] of Object.entries(raw)) {
        if (!isValidIdentifier(identifier)) continue;
        if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
        out[identifier] = {
            identifier,
            label: typeof record.label === 'string' && record.label.trim().length > 0 ? record.label.trim() : identifier,
            createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
        };
    }
    return out;
}

/**
 * Read the accounts table, dropping anything malformed OR orphaned.
 *
 * An account whose platform is absent is dropped rather than kept as a ghost:
 * the platform table is the authority on which platforms exist, and an account
 * you cannot navigate to in the panel is worse than no account at all. Keys
 * pointing at it are unaffected (they read back as ungrouped).
 */
export function normaliseAccounts(raw, platforms) {
    const out = {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [key, record] of Object.entries(raw)) {
        if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
        const platform = record.platform;
        const identifier = record.identifier;
        if (!isValidIdentifier(platform) || !isValidIdentifier(identifier)) continue;
        if (!Object.hasOwn(platforms, platform)) continue;
        // The composite key is derived, never trusted from the file — a file
        // hand-edited to disagree with itself would otherwise store an account
        // under a key that does not match its contents.
        if (key !== accountKey(platform, identifier)) continue;
        out[key] = {
            platform,
            identifier,
            label: typeof record.label === 'string' && record.label.trim().length > 0 ? record.label.trim() : identifier,
            createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
        };
    }
    return out;
}

/**
 * Durable store for named secrets. All mutations are synchronous: the file is
 * tiny, and a torn read is worse than a brief block on the host thread.
 */
export class KeyStore {
    /** @param {string} filePath - absolute path to keys.json. */
    constructor(filePath) {
        this.filePath = filePath;
        this.dir = dirname(filePath);
        this.data = { version: STORE_VERSION, policy: normalisePolicy(undefined), platforms: {}, accounts: {}, keys: {} };
        this.#load();
    }

    #load() {
        if (!existsSync(this.filePath)) return;
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
        }
        catch (error) {
            throw new Error(`dsh-key-panel: could not parse ${this.filePath}: ${error.message}`);
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`dsh-key-panel: ${this.filePath} must contain a JSON object`);
        }
        const keys = parsed.keys;
        if (keys !== undefined) {
            if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
                throw new Error(`dsh-key-panel: ${this.filePath} "keys" must be an object`);
            }
            for (const [name, record] of Object.entries(keys)) {
                if (!isValidKeyName(name)) {
                    throw new Error(`dsh-key-panel: stored name "${name}" is invalid; expected DSH_[A-Z0-9_]+`);
                }
                if (record === null || typeof record !== 'object' || typeof record.value !== 'string') {
                    throw new Error(`dsh-key-panel: stored entry "${name}" has no string value`);
                }
            }
        }
        // Grouping tables are read defensively — see the note at the top of
        // this file on why they do not get the strict treatment `keys` does.
        const platforms = normalisePlatforms(parsed.platforms);
        const accounts = normaliseAccounts(parsed.accounts, platforms);
        this.data = {
            version: STORE_VERSION,
            policy: normalisePolicy(parsed.policy),
            platforms,
            accounts,
            // Keys that point at a platform or account that did not survive the
            // defensive read above are NOT deleted here. Dropping the grouping
            // would be fine, but dropping the key would lose a secret because a
            // label was malformed. They simply read back as ungrouped.
            keys: keys ?? {},
        };
    }

    #persist() {
        mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
        const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
        let handle;
        try {
            // fsync before rename: without it a crash can leave the renamed file
            // present but empty, which would read back as "all keys deleted".
            writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: FILE_MODE });
            handle = openSync(tmp, 'r+');
            fsyncSync(handle);
            closeSync(handle);
            handle = undefined;
            renameSync(tmp, this.filePath);
        }
        catch (error) {
            try {
                if (handle !== undefined) closeSync(handle);
            }
            catch { /* the rename is the operation that matters */ }
            try {
                if (existsSync(tmp)) unlinkSync(tmp);
            }
            catch { /* best effort */ }
            throw error;
        }
    }

    // ── Policy ──────────────────────────────────────────────────────────────

    /** The current access policy. */
    policy() {
        return { ...this.data.policy };
    }

    /**
     * Replace the access policy. Returns the stored policy.
     *
     * Validation here is strict and the previous policy is left untouched on
     * failure, so a bad call cannot silently reset the operator's choice.
     */
    setPolicy({ accessMode, scopePattern }) {
        const next = validatePolicyInput({
            [ACCESS_MODE_FIELD]: accessMode,
            [SCOPE_PATTERN_FIELD]: scopePattern,
        });
        this.data.policy = next;
        this.#persist();
        return { ...next };
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    /**
     * Project a stored record for callers, resolving its grouping.
     *
     * Grouping is reported only when BOTH the platform and the account still
     * exist. A key whose platform was dropped (corrupt table, or the operator
     * deleted it) reads back as ungrouped rather than carrying a dangling
     * reference — the panel then shows it under "ungrouped", where the operator
     * can re-file it. The stored fields are left alone; rewriting keys to clear
     * them would risk a secret in exchange for a tidier file.
     */
    #project(name, record) {
        const platform = record.platform;
        const account = record.account;
        const grouped = typeof platform === 'string'
            && typeof account === 'string'
            && Object.hasOwn(this.data.platforms, platform)
            && Object.hasOwn(this.data.accounts, accountKey(platform, account));
        return {
            name,
            description: record.description,
            value: record.value,
            origin: record.origin ?? ORIGIN_OPERATOR,
            ...(grouped ? { platform, account, field: record.field } : {}),
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        };
    }

    /** Every key, values included. Only the host side and the settings gateway may call this. */
    list() {
        return Object.entries(this.data.keys).map(([name, record]) => this.#project(name, record));
    }

    /** One key, value included, or undefined. */
    get(name) {
        const record = this.data.keys[name];
        if (record === undefined) return undefined;
        return this.#project(name, record);
    }

    /**
     * Values only, for the shell-env resolver. Returns a plain object so the
     * caller can hand it to the registry without exposing record metadata.
     */
    values() {
        const out = {};
        for (const [name, record] of Object.entries(this.data.keys)) out[name] = record.value;
        return out;
    }

    /** Descriptions only, for the registry's enumerable declaration pass. */
    descriptions() {
        const out = {};
        for (const [name, record] of Object.entries(this.data.keys)) out[name] = record.description;
        return out;
    }

    has(name) {
        return Object.hasOwn(this.data.keys, name);
    }

    /** Names only — safe to log. */
    names() {
        return Object.keys(this.data.keys).sort();
    }

    // ── Writes ──────────────────────────────────────────────────────────────

    /**
     * Insert or replace one key.
     *
     * @param {string} name - variable name.
     * @param {string} value - secret.
     * @param {string} description - non-blank description for the registry.
     * @param {{ origin?: string, platform?: string, account?: string, field?: string }} [options]
     *        provenance, and optionally the credential slot this key fills.
     * @returns {object} the projected record, value included.
     */
    set(name, value, description, options = {}) {
        if (!isValidKeyName(name)) {
            throw new Error(`invalid key name "${name}"; must match ${String(KEY_NAME_PATTERN)} (the DSH shell-env registry requires a DSH_ prefix)`);
        }
        const cleanValue = normaliseValue(value);
        const cleanDescription = normaliseDescription(description);
        const origin = options.origin === ORIGIN_MODEL ? ORIGIN_MODEL : ORIGIN_OPERATOR;
        const now = Date.now();
        const existing = this.data.keys[name];

        // Grouping follows the EXISTING record unless the caller supplies a new
        // slot, for the same reason provenance does. The model's key_panel_set
        // knows nothing about platforms; if it cleared these on every write, a
        // model rotating its own key would silently un-file it.
        let slot = existing?.platform === undefined && existing?.account === undefined
            ? undefined
            : { platform: existing.platform, account: existing.account, field: existing.field };
        if (options.platform !== undefined || options.account !== undefined) {
            slot = this.#validateSlot(options.platform, options.account, options.field);
        }

        const record = {
            value: cleanValue,
            description: cleanDescription,
            // Provenance follows the CREATOR, not the last writer: a model
            // overwriting its own key keeps "model", and a model cannot
            // launder an operator key into its own by writing to it (policy
            // forbids that write in the first place, and this keeps the
            // invariant even if the policy is later loosened).
            origin: existing?.origin ?? origin,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        if (slot !== undefined) {
            record.platform = slot.platform;
            record.account = slot.account;
            record.field = slot.field;
        }
        this.data.keys[name] = record;
        this.#persist();
        return this.#project(name, record);
    }

    /**
     * Check that a slot refers to something real, and return it.
     *
     * Rejects a platform or account that has not been created. The panel always
     * creates those first, and the model never supplies a slot at all, so a
     * dangling slot here means a programming error rather than user input — but
     * it is checked because the alternative is a key that no panel view can
     * show, which looks like a lost secret.
     */
    #validateSlot(platform, account, field) {
        if (!isValidIdentifier(platform)) {
            throw new Error(`invalid platform identifier "${platform}"; create the platform first`);
        }
        if (!Object.hasOwn(this.data.platforms, platform)) {
            throw new Error(`unknown platform "${platform}"; create it before filing a key under it`);
        }
        if (!isValidIdentifier(account)) {
            throw new Error(`invalid account identifier "${account}"; create the account first`);
        }
        if (!Object.hasOwn(this.data.accounts, accountKey(platform, account))) {
            throw new Error(`unknown account "${account}" under platform "${platform}"; create it first`);
        }
        if (!isValidField(field)) {
            throw new Error(`invalid field "${field}"; must be one of ${KEY_FIELDS.join(', ')}`);
        }
        return { platform, account, field };
    }

    /** Remove one key. Returns true when something was removed. */
    remove(name) {
        if (!Object.hasOwn(this.data.keys, name)) return false;
        delete this.data.keys[name];
        this.#persist();
        return true;
    }

    // ── Platforms and accounts ──────────────────────────────────────────────

    /** Every platform, sorted by identifier. */
    platforms() {
        return Object.values(this.data.platforms).sort((a, b) => a.identifier.localeCompare(b.identifier));
    }

    /**
     * Every account, optionally filtered to one platform, sorted by identifier.
     *
     * @param {string} [platform] - restrict to this platform.
     */
    accounts(platform) {
        const all = Object.values(this.data.accounts);
        const scope = platform === undefined ? all : all.filter((a) => a.platform === platform);
        return scope.sort((a, b) => a.identifier.localeCompare(b.identifier));
    }

    /** Key names filed under a platform, or under one account of it. */
    namesIn(platform, account) {
        return Object.entries(this.data.keys)
            .filter(([, record]) => record.platform === platform && (account === undefined || record.account === account))
            .map(([name]) => name)
            .sort();
    }

    /**
     * Create a platform. Returns the stored entry.
     *
     * @param {string} identifier - the name spliced into variable names, e.g. "CF".
     * @param {{ label?: string }} [options] - display name; defaults to the identifier.
     */
    addPlatform(identifier, options = {}) {
        if (!isValidIdentifier(identifier)) {
            throw new Error(`invalid platform identifier "${identifier}"; must match ${String(IDENTIFIER_PATTERN)}`);
        }
        if (Object.hasOwn(this.data.platforms, identifier)) {
            throw new Error(`platform "${identifier}" already exists`);
        }
        const label = typeof options.label === 'string' && options.label.trim().length > 0 ? options.label.trim() : identifier;
        this.data.platforms[identifier] = { identifier, label, createdAt: Date.now() };
        this.#persist();
        return { ...this.data.platforms[identifier] };
    }

    /**
     * Change a platform's display name.
     *
     * Only the label. The identifier is baked into every variable name filed
     * under it, so renaming it is a data migration rather than an edit — see
     * decision D10, which defers that to a later version.
     */
    setPlatformLabel(identifier, label) {
        const entry = this.data.platforms[identifier];
        if (entry === undefined) throw new Error(`unknown platform "${identifier}"`);
        const clean = typeof label === 'string' ? label.trim() : '';
        entry.label = clean.length > 0 ? clean : identifier;
        this.#persist();
        return { ...entry };
    }

    /**
     * Remove a platform. Refuses while anything still refers to it.
     *
     * The refusal is deliberate and is not a convenience check: deleting the
     * platform would orphan its accounts and un-file its keys, and the only
     * alternatives are silently deleting secrets or silently losing their
     * grouping. Both are worse than an error the operator can act on, so the
     * caller must clear the contents first — which also means the operator is
     * the one who decides what happens to each secret.
     *
     * @param {string} identifier - platform to remove.
     * @param {{ force?: boolean }} [options] - `force` removes it anyway,
     *        un-filing its keys WITHOUT deleting them. Accounts go with it.
     * @returns {{ removed: boolean, unfiled: string[] }} key names that became ungrouped.
     */
    removePlatform(identifier, options = {}) {
        if (!Object.hasOwn(this.data.platforms, identifier)) return { removed: false, unfiled: [] };
        const held = this.namesIn(identifier);
        if (held.length > 0 && options.force !== true) {
            throw new Error(`platform "${identifier}" still holds ${held.length} key(s); remove or re-file them first, or pass force to un-file them`);
        }
        for (const account of this.accounts(identifier)) delete this.data.accounts[accountKey(identifier, account.identifier)];
        delete this.data.platforms[identifier];
        // Keys keep their values; only their grouping is cleared, so they show
        // up under "ungrouped" where the operator can re-file them.
        for (const name of held) {
            delete this.data.keys[name].platform;
            delete this.data.keys[name].account;
            delete this.data.keys[name].field;
        }
        this.#persist();
        return { removed: true, unfiled: held };
    }

    /**
     * Add an account under an existing platform.
     *
     * @param {string} platform - owning platform identifier.
     * @param {string} identifier - account identifier, unique within the platform.
     * @param {{ label?: string }} [options] - display name; defaults to the identifier.
     */
    addAccount(platform, identifier, options = {}) {
        if (!Object.hasOwn(this.data.platforms, platform)) {
            throw new Error(`unknown platform "${platform}"; create it first`);
        }
        if (!isValidIdentifier(identifier)) {
            throw new Error(`invalid account identifier "${identifier}"; must match ${String(IDENTIFIER_PATTERN)}`);
        }
        const key = accountKey(platform, identifier);
        if (Object.hasOwn(this.data.accounts, key)) {
            throw new Error(`account "${identifier}" already exists under platform "${platform}"`);
        }
        const label = typeof options.label === 'string' && options.label.trim().length > 0 ? options.label.trim() : identifier;
        this.data.accounts[key] = { platform, identifier, label, createdAt: Date.now() };
        this.#persist();
        return { ...this.data.accounts[key] };
    }

    /** Change an account's display name. Same reasoning as setPlatformLabel. */
    setAccountLabel(platform, identifier, label) {
        const key = accountKey(platform, identifier);
        const entry = this.data.accounts[key];
        if (entry === undefined) throw new Error(`unknown account "${identifier}" under platform "${platform}"`);
        const clean = typeof label === 'string' ? label.trim() : '';
        entry.label = clean.length > 0 ? clean : identifier;
        this.#persist();
        return { ...entry };
    }

    /**
     * Remove an account. Refuses while keys are still filed under it.
     *
     * @param {string} platform - owning platform identifier.
     * @param {string} identifier - account identifier.
     * @param {{ force?: boolean }} [options] - `force` un-files its keys instead of refusing.
     * @returns {{ removed: boolean, unfiled: string[] }} key names that became ungrouped.
     */
    removeAccount(platform, identifier, options = {}) {
        const key = accountKey(platform, identifier);
        if (!Object.hasOwn(this.data.accounts, key)) return { removed: false, unfiled: [] };
        const held = this.namesIn(platform, identifier);
        if (held.length > 0 && options.force !== true) {
            throw new Error(`account "${identifier}" still holds ${held.length} key(s); remove or re-file them first, or pass force to un-file them`);
        }
        delete this.data.accounts[key];
        for (const name of held) {
            delete this.data.keys[name].platform;
            delete this.data.keys[name].account;
            delete this.data.keys[name].field;
        }
        this.#persist();
        return { removed: true, unfiled: held };
    }
}

export function keyStorePath(dshHome) {
    return join(dshHome, 'key-panel', 'keys.json');
}
