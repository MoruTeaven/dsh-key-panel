/**
 * Model-facing tools for @moruteaven/dsh-key-panel.
 *
 * These are the tools the ASSISTANT calls. Whether any of them exist at all
 * depends on the operator's access mode:
 *
 *   readonly — `key_panel_intent` only. No capability to change anything is
 *              registered, so there is nothing to refuse.
 *   write    — `key_panel_list` and `key_panel_set` (create + replace own keys).
 *   edit     — the above plus `key_panel_delete`.
 *
 * `key_panel_list` is registered in every non-readonly mode so the model can
 * discover which names exist without being able to read any value. Names and
 * descriptions are not secrets; values never cross this boundary.
 *
 * `key_panel_intent` is the one tool registered in EVERY mode, readonly
 * included, because declaring a purpose is not a mutation. Readonly is in fact
 * where it matters most: the model can still reference `$DSH_*` in a shell
 * command there, so the operator has the least other visibility into what is
 * being used and why.
 *
 * Two invariants hold regardless of mode:
 *
 *  1. **No tool returns a value.** The only channel that carries a secret is
 *     the shell environment the host itself populates. A tool that could echo
 *     a value would put it in the transcript, which is the exact outcome this
 *     plugin exists to prevent.
 *
 *  2. **Deletion is two-phase.** `key_panel_delete` with no `confirm` returns a
 *     token describing what would be removed; only a second call carrying that
 *     token performs the removal. A single hallucinated call therefore cannot
 *     destroy a credential.
 *
 * The policy check runs here, on the host, against the persisted policy — not
 * in the client. A model cannot widen its own reach by editing a request.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { KIND_INTENT } from './usage.js';
import { checkModelAccess } from './policy.js';
import { isValidKeyName, ORIGIN_MODEL } from './store.js';

/** How long a delete confirmation token stays valid. */
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * Mint and track delete-confirmation tokens for one plugin instance.
 *
 * Tokens are random, single-use and short-lived. They are held in memory only:
 * a restart invalidates every outstanding confirmation, which is the right
 * default for a destructive operation.
 */
class ConfirmationLedger {
    constructor() {
        /** @type {Map<string, {name: string, expiresAt: number}>} */
        this.pending = new Map();
    }

    /** Mint a token for `name`, replacing any token already outstanding for it. */
    issue(name) {
        this.#sweep();
        // One outstanding token per name: a second request supersedes the first
        // rather than accumulating authority for the same target.
        for (const [token, entry] of this.pending) {
            if (entry.name === name) this.pending.delete(token);
        }
        const token = randomToken();
        this.pending.set(token, { name, expiresAt: Date.now() + CONFIRMATION_TTL_MS });
        return token;
    }

    /** Consume a token for `name`. Returns true only on an exact, unexpired match. */
    consume(token, name) {
        this.#sweep();
        const entry = this.pending.get(token);
        if (entry === undefined || entry.name !== name) return false;
        this.pending.delete(token);
        return true;
    }

    #sweep() {
        const now = Date.now();
        for (const [token, entry] of this.pending) {
            if (entry.expiresAt <= now) this.pending.delete(token);
        }
    }
}

/** A short, unpredictable, URL-safe token. */
function randomToken() {
    const bytes = new Uint8Array(18);
    globalThis.crypto.getRandomValues(bytes);
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
}

/** Render a policy refusal as a tool result the model can act on. */
function refusalText(verdict, name) {
    return `Refused: ${verdict.reason}. The operator controls this in DSH Settings → Keys. Do not retry; report the refusal instead.`;
}

/**
 * Register the model-facing tools allowed by the current policy.
 *
 * Called on load and re-called whenever the policy changes, so flipping the
 * mode takes effect immediately without a restart.
 *
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx - host context.
 * @param {import('./store.js').KeyStore} deps.store - the live store.
 * @param {() => void} deps.resync - re-declare the shell env contribution.
 * @param {ConfirmationLedger} deps.ledger - delete confirmations.
 * @param {(kind: string, names: string[], extra?: object) => void} [deps.record]
 *   writes one entry to the usage log. Optional: a caller with no log (the test
 *   suite, mostly) simply does not pass it, and declaration becomes a no-op.
 * @returns {() => void} disposer removing every tool registered here.
 */
export function registerModelTools({ ctx, store, resync, ledger, record = () => {} }) {
    const policy = store.policy();
    const disposers = [];

    /** Read the policy fresh at call time: it may have changed since registration. */
    const livePolicy = () => store.policy();

    if (policy.accessMode !== 'readonly') {
        disposers.push(ctx.tools.register(defineTool({
            name: 'key_panel_list',
            description: [
                'List the names and purposes of credentials stored in the operator\'s key panel.',
                'Returns names and descriptions only — never values.',
                'To USE a credential, reference its name as $NAME in a shell command; the host substitutes the value.',
            ].join(' '),
            parameters: {},
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        keys: {
                            type: 'array',
                            required: true,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    name: { type: 'string', required: true },
                                    description: { type: 'string', required: true },
                                    origin: { type: 'string', required: true },
                                },
                            },
                        },
                        count: { type: 'number', required: true },
                        accessMode: { type: 'string', required: true },
                    },
                },
                render: (_args, value) => {
                    if (value.count === 0) {
                        return [{ type: 'text', text: `No credentials stored yet (model access: ${value.accessMode}).` }];
                    }
                    const lines = value.keys.map(k => `- $${k.name} — ${k.description}${k.origin === 'model' ? ' (created by you)' : ''}`);
                    return [{ type: 'text', text: `Stored credentials (model access: ${value.accessMode}):\n${lines.join('\n')}\n\nUse them as $NAME in a shell command.` }];
                },
            },
            async execute() {
                return {
                    keys: store.list().map(({ name, description, origin }) => ({ name, description, origin })),
                    count: store.names().length,
                    accessMode: livePolicy().accessMode,
                };
            },
        })));
    }

    if (policy.accessMode === 'write' || policy.accessMode === 'edit') {
        disposers.push(ctx.tools.register(defineTool({
            name: 'key_panel_set',
            description: [
                'Create or replace a credential in the operator\'s key panel.',
                'The value is stored on the host and injected into your shell as $NAME; it is never echoed back.',
                'The name must start with DSH_ and use only A-Z, 0-9 and underscore.',
            ].join(' '),
            parameters: {
                name: {
                    type: 'string',
                    required: true,
                    description: 'Variable name, e.g. DSH_CF_API_TOKEN. Uppercase, DSH_ prefix.',
                },
                value: {
                    type: 'string',
                    required: true,
                    description: 'The secret itself. It will not be shown again after storing.',
                },
                description: {
                    type: 'string',
                    required: true,
                    description: 'What this credential is for, shown to the operator and to you on later turns.',
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        stored: { type: 'boolean', required: true },
                        name: { type: 'string', required: true },
                        created: { type: 'boolean', required: true },
                        masked: { type: 'string', required: true },
                        message: { type: 'string', required: true },
                    },
                },
                render: (_args, value) => [{
                    type: 'text',
                    text: value.stored
                        ? `${value.created ? 'Created' : 'Updated'} $${value.name} (${value.masked}). Reference it as $${value.name} in a shell command.`
                        : value.message,
                }],
            },
            async execute(args) {
                const name = args.name.trim();
                if (!isValidKeyName(name)) {
                    return {
                        stored: false,
                        name,
                        created: false,
                        masked: '',
                        message: 'Refused: the name must start with DSH_ and use only A-Z, 0-9 and underscore (e.g. DSH_CF_API_TOKEN).',
                    };
                }
                const existed = store.has(name);
                const existing = existed ? store.get(name) : undefined;
                const verdict = checkModelAccess(livePolicy(), existed ? 'update' : 'create', name, {
                    existed,
                    origin: existing?.origin,
                });
                if (!verdict.allowed) {
                    return { stored: false, name, created: false, masked: '', message: refusalText(verdict, name) };
                }
                // Validation failures (blank value/description) are thrown rather
                // than returned: they are argument errors, not policy refusals.
                const record = store.set(name, args.value, args.description, { origin: ORIGIN_MODEL });
                resync();
                ctx.logger?.info?.(`dsh-key-panel: model ${existed ? 'updated' : 'created'} ${name}`);
                return {
                    stored: true,
                    name,
                    created: !existed,
                    masked: record.value.length <= 12 ? '•'.repeat(record.value.length) : `${record.value.slice(0, 4)}${'•'.repeat(12)}${record.value.slice(-4)}`,
                    message: '',
                };
            },
        })));
    }

    if (policy.accessMode === 'edit') {
        disposers.push(ctx.tools.register(defineTool({
            name: 'key_panel_delete',
            description: [
                'Delete a credential from the operator\'s key panel.',
                'This is two-phase: call once without `confirm` to see what would be removed and receive a token, then call again with that token.',
                'Never invent a token.',
            ].join(' '),
            parameters: {
                name: {
                    type: 'string',
                    required: true,
                    description: 'The DSH_ name to delete.',
                },
                confirm: {
                    type: 'string',
                    description: 'The confirmation token from the first call. Omit on the first call.',
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        deleted: { type: 'boolean', required: true },
                        name: { type: 'string', required: true },
                        needsConfirmation: { type: 'boolean', required: true },
                        token: { type: 'string' },
                        message: { type: 'string', required: true },
                    },
                },
                render: (_args, value) => [{ type: 'text', text: value.message }],
            },
            async execute(args) {
                const name = args.name.trim();
                const existing = store.get(name);

                const verdict = checkModelAccess(livePolicy(), 'delete', name, { existed: existing !== undefined });
                if (!verdict.allowed) {
                    return { deleted: false, name, needsConfirmation: false, message: refusalText(verdict, name) };
                }
                if (existing === undefined) {
                    return { deleted: false, name, needsConfirmation: false, message: `No credential named $${name}.` };
                }

                const token = typeof args.confirm === 'string' ? args.confirm.trim() : '';
                if (token.length === 0) {
                    const issued = ledger.issue(name);
                    return {
                        deleted: false,
                        name,
                        needsConfirmation: true,
                        token: issued,
                        message: [
                            `About to delete $${name} — ${existing.description}.`,
                            'Call key_panel_delete again with the same name and confirm set to the returned token to proceed.',
                            `The token expires in ${Math.round(CONFIRMATION_TTL_MS / 60000)} minutes.`,
                        ].join(' '),
                    };
                }

                if (!ledger.consume(token, name)) {
                    return {
                        deleted: false,
                        name,
                        needsConfirmation: false,
                        message: 'Refused: that confirmation token is not valid for this name (it may have expired, been used already, or been superseded). Start again without `confirm`.',
                    };
                }

                store.remove(name);
                resync();
                ctx.logger?.info?.(`dsh-key-panel: model deleted ${name}`);
                return { deleted: true, name, needsConfirmation: false, message: `Deleted $${name}.` };
            },
        })));
    }

    // ── Purpose declaration ──────────────────────────────────────────────────
    //
    // Registered in EVERY mode, including readonly. Declaring an intent is not
    // a mutation: in readonly the model may still reference $DSH_* names in a
    // shell command, so it is exactly the mode where knowing why matters most.
    //
    // This records the model's own statement. It is not evidence that a key was
    // used — the usage log records that separately, from the shell side. The
    // panel shows the two streams side by side and leaves the correlating to
    // the person reading it.
    disposers.push(ctx.tools.register(defineTool({
        name: 'key_panel_intent',
        description: [
            'Say what you are about to do with one or more stored credentials, before you do it.',
            'Purely a note to the operator for their own records — it grants nothing and changes nothing.',
            'Keep it to one short line, e.g. "deploy the staging worker".',
            'Skip it for trivial or routine commands; it is not a required step.',
        ].join(' '),
        parameters: {
            purpose: {
                type: 'string',
                required: true,
                description: 'One short line describing the task. No secrets, no command text.',
            },
            names: {
                type: 'array',
                items: { type: 'string' },
                description: 'The DSH_ names you expect to use. Names only — never values.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    recorded: { type: 'boolean', required: true },
                    message: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        async execute(args) {
            const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
            if (purpose.length === 0) {
                return { recorded: false, message: 'Nothing recorded: `purpose` was blank.' };
            }
            // Only names that actually exist are kept, so a hallucinated name
            // cannot pollute the log with something the operator cannot resolve.
            const known = new Set(store.names());
            const requested = Array.isArray(args.names) ? args.names : [];
            const names = requested.filter(n => typeof n === 'string' && known.has(n));
            const unknown = requested.filter(n => typeof n === 'string' && !known.has(n));
            record(KIND_INTENT, names, { note: purpose });
            const warning = unknown.length > 0 ? ` Ignored ${unknown.length} name(s) that are not stored.` : '';
            return { recorded: true, message: `Noted: ${purpose}${warning}` };
        },
    })));
    return () => {
        for (const dispose of disposers) dispose();
        disposers.length = 0;
    };
}

export { ConfirmationLedger, CONFIRMATION_TTL_MS };
