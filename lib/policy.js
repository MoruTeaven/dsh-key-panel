/**
 * Access policy for @moruteaven/dsh-key-panel.
 *
 * The operator picks one of three modes in the settings page. Modes are
 * enforced on the HOST side, so a compromised or confused model cannot widen
 * its own access: the check runs before any mutation, against state the model
 * cannot reach.
 *
 *   readonly  — the model may use keys but never change them. No model-facing
 *               tool is registered at all, so the capability is absent rather
 *               than merely refused.
 *   write     — the model may create keys, and may replace the VALUE of a key
 *               it created. It can never delete, and never touch a key the
 *               operator created.
 *   edit      — the model may create, replace and delete. Destructive calls
 *               still require an explicit confirmation token, so an accident
 *               cannot silently remove a credential.
 *
 * `scopePattern` optionally narrows every mode to names matching one prefix
 * glob (default: no restriction). Operators who want an agent to manage only
 * its own credentials set it to e.g. `DSH_AGENT_*`.
 *
 * Trust model note: keys are stored in plaintext (see SECURITY.md). The policy
 * here governs the MODEL's reach; it does not encrypt anything, and it is not
 * a defence against a process that can already read the DSH home directory.
 */

/** Every access mode, in ascending order of privilege. */
export const ACCESS_MODES = Object.freeze(['readonly', 'write', 'edit']);

/** The default mode: the model can use keys but not change them. */
export const DEFAULT_ACCESS_MODE = 'readonly';

/** Key holding the mode inside the persisted settings document. */
export const ACCESS_MODE_FIELD = 'accessMode';

/** Key holding the optional name restriction. */
export const SCOPE_PATTERN_FIELD = 'scopePattern';

/** Rank one mode so callers can compare privilege without string tables. */
export function modeRank(mode) {
    const index = ACCESS_MODES.indexOf(mode);
    return index === -1 ? -1 : index;
}

/** True when `mode` is one of the three recognised values. */
export function isAccessMode(mode) {
    return typeof mode === 'string' && ACCESS_MODES.includes(mode);
}

/**
 * Normalise a scope pattern.
 *
 * Accepts `null` / `undefined` / `""` as "no restriction". A pattern must be a
 * `DSH_`-prefixed glob containing only the characters legal in a variable name
 * plus `*`. This deliberately cannot express a path or a regex: it is matched
 * with a tiny glob matcher, never handed to `RegExp`.
 *
 * @param {unknown} value - candidate pattern.
 * @returns {string|null} the normalised pattern, or null for "unrestricted".
 */
export function normaliseScopePattern(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new Error('scopePattern must be a string');
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (!trimmed.startsWith('DSH_')) {
        throw new Error('scopePattern must start with DSH_ (the shell-env registry only accepts DSH_ names)');
    }
    if (!/^DSH_[A-Z0-9_*]*$/.test(trimmed)) {
        throw new Error('scopePattern may only contain A-Z, 0-9, underscore and * after the DSH_ prefix');
    }
    return trimmed;
}

/**
 * Compile a scope pattern into a predicate.
 *
 * The glob vocabulary is exactly one metacharacter: `*`, meaning "any run of
 * characters, including the empty run". Everything else is matched literally.
 * Compiling to a predicate (rather than a RegExp) keeps this a pure function
 * of the pattern string with no escaping hazards.
 *
 * @param {string|null} pattern - a pattern from {@link normaliseScopePattern}.
 * @returns {(name: string) => boolean} predicate; always true when unrestricted.
 */
export function scopeMatcher(pattern) {
    if (pattern === null || pattern === undefined) return () => true;
    const segments = pattern.split('*');

    // No wildcard at all: the pattern is an exact name. Handled separately
    // because the general walk below assumes a leading and a trailing segment
    // to anchor against, and would never run for a one-segment pattern.
    if (segments.length === 1) return name => name === pattern;

    return name => {
        // Leftmost segment must be a prefix, rightmost must be a suffix, and the
        // middle segments must appear in order.
        if (!name.startsWith(segments[0])) return false;
        let cursor = segments[0].length;
        for (let index = 1; index < segments.length - 1; index += 1) {
            const found = name.indexOf(segments[index], cursor);
            if (found === -1) return false;
            cursor = found + segments[index].length;
        }
        const tail = segments[segments.length - 1];
        if (tail.length === 0) return true;
        return name.endsWith(tail) && name.length - cursor >= tail.length;
    };
}

/**
 * Decide whether the model may perform one operation.
 *
 * This is the single authority for the model's reach; the gateway calls it
 * before every mutation and never re-implements the rules.
 *
 * @param {object} policy - normalised `{ accessMode, scopePattern }`.
 * @param {'read'|'create'|'update'|'delete'} operation - attempted operation.
 * @param {string} [name] - target key name; required for anything but `read`.
 * @param {{ existed?: boolean }} [context] - whether the key already existed.
 * @returns {{ allowed: boolean, reason?: string }} the verdict.
 */
export function checkModelAccess(policy, operation, name, context = {}) {
    const mode = isAccessMode(policy?.accessMode) ? policy.accessMode : DEFAULT_ACCESS_MODE;
    if (operation === 'read') return { allowed: true };

    if (mode === 'readonly') {
        return {
            allowed: false,
            reason: 'the operator has set model access to "readonly"; keys can only be changed from the settings page',
        };
    }

    const pattern = normaliseScopePattern(policy?.scopePattern ?? null);
    if (pattern !== null && typeof name === 'string' && !scopeMatcher(pattern)(name)) {
        return {
            allowed: false,
            reason: `model access is restricted to names matching ${pattern}; "${name}" is outside that scope`,
        };
    }

    if (operation === 'create') return { allowed: true };

    if (operation === 'update') {
        // In `write` mode: only allow replacing keys the model created.
        // In `edit` mode: allow any replacement without provenance checks.
        // Rationale: edit grants full mutate/delete capability; we protect against
        // accidental deletion via two-phase tokens, but value replacement does not
        // require a token since it doesn't remove the credential — and edit already
        // implies operator trust that model can change secrets in its own scope.
        const origin = context.origin;
        if (mode === 'write' && context.existed === true && origin !== 'model') {
            return {
                allowed: false,
                reason: `"${name}" was created by the operator; mode "write" can only replace keys the model created (switch to "edit" to override)`,
            };
        }
        return { allowed: true };
    }

    if (operation === 'delete') {
        if (mode !== 'edit') {
            return {
                allowed: false,
                reason: `deleting a key requires model access "edit"; the current mode is "${mode}"`,
            };
        }
        return { allowed: true };
    }

    return { allowed: false, reason: `unknown operation "${String(operation)}"` };
}

/**
 * Validate a policy for WRITING.
 *
 * Unlike {@link normalisePolicy}, which degrades bad input so a corrupt file
 * cannot brick the app, this rejects it. The two directions are deliberately
 * asymmetric: reading persisted state must be forgiving, while accepting new
 * state from a caller must be strict — silently turning a requested "edit" into
 * "readonly" would look like the setting took effect when it did not.
 *
 * @param {{accessMode?: unknown, scopePattern?: unknown}} input - requested policy.
 * @returns {{ accessMode: string, scopePattern: string|null }} the validated policy.
 * @throws when the mode is unknown or the pattern is malformed.
 */
export function validatePolicyInput(input) {
    const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (!isAccessMode(source[ACCESS_MODE_FIELD])) {
        throw new Error(`unknown access mode ${JSON.stringify(source[ACCESS_MODE_FIELD])}; expected one of ${ACCESS_MODES.join(', ')}`);
    }
    return {
        accessMode: source[ACCESS_MODE_FIELD],
        scopePattern: normaliseScopePattern(source[SCOPE_PATTERN_FIELD] ?? null),
    };
}

/**
 * Normalise a persisted policy document.
 *
 * Persisted settings are operator input that has round-tripped through a file,
 * so they are re-validated on every load rather than trusted. Unlike
 * {@link validatePolicyInput} this never throws: a malformed value degrades to
 * the safest reading (readonly / unrestricted) rather than failing the load.
 *
 * @param {unknown} raw - the `policy` object read from settings.json.
 * @returns {{ accessMode: string, scopePattern: string|null }} normalised policy.
 */
export function normalisePolicy(raw) {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const mode = isAccessMode(source[ACCESS_MODE_FIELD]) ? source[ACCESS_MODE_FIELD] : DEFAULT_ACCESS_MODE;
    let pattern = null;
    try {
        pattern = normaliseScopePattern(source[SCOPE_PATTERN_FIELD] ?? null);
    }
    catch {
        // A pattern that no longer validates degrades to "unrestricted" rather
        // than refusing to boot: a corrupt settings file must not brick the app.
        pattern = null;
    }
    return { accessMode: mode, scopePattern: pattern };
}
