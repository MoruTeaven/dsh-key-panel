/**
 * Dynamic prompt section: the current key inventory.
 *
 * WHY THIS EXISTS
 *
 * The static system-prompt section (order 7777) explains the panel's MECHANICS
 * — how `$DSH_*` reaches the shell and what each access mode allows — but it
 * deliberately names no keys, because apply() runs once and keys change while
 * the process lives. Before this module that left the model with only two
 * discovery channels, and both fail in practice: the MCP catalogue is not
 * visible in every host composition (see taskboard, "MCP 注册静默失效"), and
 * enumerating `env` requires the model to think of it unprompted. The result
 * was the operator's complaint this module answers: ask the model to publish a
 * package and it never learns that a stored npm token exists, so `$DSH_*`
 * goes unused even though the substitution would have succeeded.
 *
 * The host resolves a section's `text` on EVERY prompt assembly when it is a
 * function (dsh-system-prompt's `assemble()`), so a function section re-renders
 * the inventory on every request with no registration churn: `resync` does not
 * need to touch it, and a key added through the panel is listed from the very
 * next turn. A static-text section could not do that without being re-inserted
 * on every store change.
 *
 * THE ONE INVARIANT
 *
 * Nothing here may carry a key VALUE. The input is `store.metadata()`, the
 * projection with no value field (see lib/store.js), and `renderKeyInventory`
 * reads only `name` and `description` — a defensive whitelist, so even a caller
 * that hands it a value-carrying record cannot leak through. Names and
 * descriptions are not secrets by design (lib/tools.js, header note); the
 * readonly mode's own copy says the names are already in the shell environment.
 */

/** Prompt section name. Unique across the global layer (siblings: key-panel, key-panel:resources). */
export const INVENTORY_SECTION = 'key-panel:keys';

/**
 * Placement immediately after the base section (7777) and the MCP hint
 * (7778). External contributions may use any finite order; 7779 keeps the
 * three key-panel sections contiguous so the model reads them as one block.
 */
export const INVENTORY_ORDER = 7779;

/**
 * Keys listed in full before the render collapses to a count line. A prompt
 * is read every turn; 24 lines of names is cheap, a hundred is not. An
 * operator with more keys than this is explicitly told how to see the rest.
 */
export const INVENTORY_LIMIT = 24;

/** One rendered description is clamped to this many characters. */
const DESCRIPTION_CLAMP = 60;

/** Clamp one description to {@link DESCRIPTION_CLAMP} characters. */
function clampDescription(text) {
    const trimmed = String(text).trim();
    if (trimmed.length <= DESCRIPTION_CLAMP) return trimmed;
    return `${trimmed.slice(0, DESCRIPTION_CLAMP - 1)}…`;
}

/**
 * Render the inventory text the model sees.
 *
 * Pure and deterministic: sorted by name, no trailing prose drift, empty for
 * an empty store (the host drops empty sections, so an empty panel simply
 * contributes nothing). Only `name` and `description` are read; everything
 * else on the record — including any accidental `value` field — is ignored.
 *
 * @param {Array<{name: string, description?: string}>} metadata - `store.metadata()` output.
 * @param {number} [limit] - full entries before the count-line collapse.
 * @returns {string} the section text, or `''` when there is nothing to list.
 */
export function renderKeyInventory(metadata, limit = INVENTORY_LIMIT) {
    const keys = (Array.isArray(metadata) ? metadata : [])
        .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.name === 'string')
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (keys.length === 0) return '';
    const head = `本地密钥面板当前存有 ${keys.length} 个密钥，shell 命令里直接写 $DSH_XXX 引用（值永不进入对话，也无工具能读取）：`;
    const lines = keys.slice(0, limit).map(entry => {
        const description = typeof entry.description === 'string' && entry.description.trim().length > 0
            ? ` — ${clampDescription(entry.description)}`
            : '';
        return `- $${entry.name}${description}`;
    });
    const tail = keys.length > limit
        ? [`（其余 ${keys.length - limit} 个未逐条列出：在 shell 里枚举 DSH_ 前缀环境变量可看到全部名称）`]
        : [];
    return [head, ...lines, ...tail].join('\n');
}

/**
 * Register the dynamic inventory section on the host prompt registry.
 *
 * The optional chaining matches the base section's guard: a bare test context
 * without `systemPrompt` is a silent no-op, never a load failure. The section
 * is registered exactly once per apply() — its text is a function, so the
 * section never needs to be re-registered when the store changes.
 *
 * `interpolate: false` is not cosmetic. The host scans rendered section text
 * for `{{variable}}` references and THROWS on an unknown or malformed group,
 * which would turn one operator description containing `{{...}}` into a
 * failed prompt assembly on every request. The same guard is why the host's
 * own MCP-server section sets it.
 *
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx - host context.
 * @param {import('./store.js').KeyStore} deps.store - the live store.
 * @returns {void}
 */
export function registerInventorySection({ ctx, store }) {
    ctx.systemPrompt?.section?.({
        name: INVENTORY_SECTION,
        order: INVENTORY_ORDER,
        interpolate: false,
        text: () => renderKeyInventory(store.metadata()),
    });
}
