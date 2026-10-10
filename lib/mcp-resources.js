/**
 * MCP resource surface for @moruteaven/dsh-key-panel.
 *
 * WHY THIS EXISTS
 *
 * The model can already discover key NAMES by running `env | grep DSH_`, because
 * a key has to exist in the shell environment to be usable. That path is an
 * accident of how injection works, not a designed interface: it returns bare
 * names with no description, no grouping, and no indication of what is usable.
 *
 * This module replaces that accident with a real, read-only discovery channel.
 * Registering one provider on the host's `ctx.mcpResources` service makes the
 * Harness do two things for us, neither of which this plugin has to implement:
 *
 *  1. It advertises the server name in the system prompt. The `mcpResources`
 *     service owns a dynamic `MCP resource servers` section that lists every
 *     registered server, so the model learns this interface exists without the
 *     key-panel prompt section having to carry a list.
 *  2. It registers three shared model-facing tools (`list_mcp_resources`,
 *     `list_mcp_resource_templates`, `read_mcp_resource`) that route to
 *     whichever provider is in scope.
 *
 * THE ONE INVARIANT
 *
 * Nothing on this surface may ever carry a key VALUE. The shell environment the
 * host fills itself remains the only channel a secret travels through
 * (CONTRIBUTING.md, "The invariant that outranks the rest"). This is enforced
 * structurally rather than by discipline: every payload below is built from
 * `store.metadata()`, a projection that has no value field at all, so there is
 * nothing for a later edit to forget to strip. `store.values()` and
 * `store.list()` are never called from this file.
 *
 * The optional dependency is deliberate. `mcpResources` is NOT listed in this
 * plugin's `inject` array, because doing so would make key-panel fail to load
 * wherever `@deepseek-ai/dsh-mcp-resources` is absent — and a throw in `apply()`
 * takes down the whole plugin tree. `ctx.inject` expresses "when this service
 * shows up, do this" instead, which degrades to a no-op.
 */

/** Server name advertised to the model. Must be unique within the scope. */
export const SERVER_NAME = 'key-panel';

/**
 * Prompt section name for the capability hint.
 *
 * Registered ONLY when the resource server was actually published, so the model
 * is never told about an interface that is not there. The host separately lists
 * the server NAME in its own MCP section; this sentence is what connects that
 * bare name back to the panel the base key-panel section describes.
 */
export const PROMPT_SECTION = 'key-panel:resources';

/** Placement immediately after the base key-panel section (order 7777). */
export const PROMPT_ORDER = 7778;

/** The capability hint. Kept exported so the suite can assert its content. */
export const PROMPT_TEXT = '本插件同时提供一个只读的 MCP 资源服务（server 名为 key-panel），三种访问模式下均可用：用 list_mcp_resources 可列出全部密钥的名称与用途，用 read_mcp_resource 可读取其中一条的元数据。该接口只返回名称与用途，永不返回密钥值——值只能在 shell 命令中以 $NAME 引用。';

/** URI scheme for every resource on this server. */
const SCHEME = 'key-panel';

/** The single index resource; reading it returns every key's metadata. */
const INDEX_URI = `${SCHEME}://keys`;

/** Per-key URI. The name is the whole path; names are validated `DSH_*`. */
const keyUri = name => `${SCHEME}://keys/${name}`;

/**
 * Parse a resource URI back to the key name it addresses.
 *
 * Returns `undefined` for the index resource and `null` for anything that is
 * not a resource this server owns. The distinction matters: `undefined` means
 * "the index", `null` means "refuse", and collapsing the two would make a
 * malformed URI silently answer as the index.
 *
 * @param {string} uri - the requested URI.
 * @returns {string|undefined|null} key name, undefined for the index, null when unrecognised.
 */
export function parseResourceUri(uri) {
    if (typeof uri !== 'string') return null;
    let parsed;
    try {
        parsed = new URL(uri);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== `${SCHEME}:`) return null;
    if (parsed.hostname !== 'keys') return null;
    const path = parsed.pathname.replace(/^\//, '');
    if (path.length === 0) return undefined;
    // A nested path is not a resource this server mints; refuse rather than
    // guessing which segment was meant.
    if (path.includes('/')) return null;
    return decodeURIComponent(path);
}

/**
 * Render one key's metadata as the JSON body of a resource.
 *
 * Kept as a named function so the "no value" property is auditable in one
 * place: every field below comes from `store.metadata()`, which has no value.
 *
 * @param {object} meta - one entry from `store.metadata()`.
 * @returns {object} a value-free descriptor.
 */
function describeKey(meta) {
    return {
        name: meta.name,
        description: meta.description,
        origin: meta.origin,
        ...(meta.platform === undefined ? {} : { platform: meta.platform }),
        ...(meta.account === undefined ? {} : { account: meta.account }),
        ...(meta.field === undefined ? {} : { field: meta.field }),
        updatedAt: meta.updatedAt,
    };
}

/**
 * Build the provider the `mcpResources` service will route to.
 *
 * Exported separately from the registration so the whole surface is testable
 * without a Cordis container.
 *
 * @param {object} deps
 * @param {import('./store.js').KeyStore} deps.store - the live store.
 * @param {() => object} [deps.policy] - reads the current policy; defaults to the store's.
 * @returns {{request: (request: object, exec: object) => Promise<object>}} the provider.
 */
export function createResourceProvider({ store, policy = () => store.policy() }) {
    return {
        /**
         * Answer one resource operation.
         *
         * Read fresh on every call: a key added in the panel must be visible to
         * the very next tool call, with no restart, matching how the shell-env
         * registry behaves.
         *
         * @param {object} request - `{ method, cursor?, uri? }`.
         * @returns {Promise<object>} the canonical MCP result for that method.
         */
        async request(request) {
            const keys = store.metadata();

            switch (request.method) {
                case 'resources/list':
                    return { resources: listResources(keys) };

                case 'resources/templates/list':
                    // This server mints literal URIs, one per key, so it has no
                    // parameterised templates to advertise.
                    return { resourceTemplates: [] };

                case 'resources/read':
                    return { contents: [readResource(keys, request.uri, policy().accessMode)] };

                default:
                    throw new Error(`key-panel resources: unsupported method "${String(request.method)}"`);
            }
        },
    };
}

/**
 * The resource catalogue: one index plus one entry per key.
 *
 * @param {Array<object>} keys - `store.metadata()` output.
 * @returns {Array<{uri: string, name: string, description: string, mimeType: string}>} the catalogue.
 */
function listResources(keys) {
    const mode = keys.length === 0 ? 'empty' : `${keys.length} key(s)`;
    return [
        {
            uri: INDEX_URI,
            name: 'keys',
            description: `All stored credential names and purposes (${mode}). Metadata only — values are never readable here.`,
            mimeType: 'application/json',
        },
        ...keys.map(meta => ({
            uri: keyUri(meta.name),
            name: meta.name,
            description: meta.description,
            mimeType: 'application/json',
        })),
    ];
}

/**
 * Read one resource.
 *
 * @param {Array<object>} keys - `store.metadata()` output.
 * @param {string} uri - requested URI.
 * @param {string} accessMode - current policy mode, reported for context.
 * @returns {{uri: string, mimeType: string, text: string}} a value-free body.
 * @throws when the URI is not one this server mints, or names an unknown key.
 */
function readResource(keys, uri, accessMode) {
    const name = parseResourceUri(uri);
    if (name === null) throw new Error(`key-panel resources: "${String(uri)}" is not a resource of this server`);

    const body = name === undefined
        ? {
            server: SERVER_NAME,
            accessMode,
            count: keys.length,
            keys: keys.map(describeKey),
            note: 'Values are never exposed here. Use a key as $NAME in a shell command.',
        }
        : (() => {
            const meta = keys.find(candidate => candidate.name === name);
            if (meta === undefined) throw new Error(`key-panel resources: no credential named "${name}"`);
            return { server: SERVER_NAME, accessMode, key: describeKey(meta) };
        })();

    return { uri, mimeType: 'application/json', text: JSON.stringify(body, null, 2) };
}

/**
 * Publish this plugin's resources on the host's MCP resource service.
 *
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx - host context.
 * @param {import('./store.js').KeyStore} deps.store - the live store.
 * @param {{info?: Function, warn?: Function}} [deps.logger] - optional logger.
 * @returns {void} the registration is owned by `ctx` and disposed with it.
 */
export function registerResources({ ctx, store, logger }) {
    // Optional service: if `mcpResources` never loads, this callback simply
    // never runs and key-panel behaves exactly as it did before.
    //
    // The callback fires when its dependency settles, which can be AFTER
    // apply() has returned — verified against real cordis, not assumed. Nothing
    // here may therefore be read synchronously by apply()'s caller, and the
    // published state must be observed through the service (as the panel does)
    // rather than captured in a local.
    //
    // `ctx.inject` is a Cordis Context method, so it is present on every real
    // host; the optional call matches how index.js guards `ctx.systemPrompt`,
    // and keeps a bare test context from throwing where nothing is being tested.
    ctx.inject?.(['mcpResources'], (inner) => {
        let dispose;
        try {
            dispose = inner.mcpResources.register(SERVER_NAME, createResourceProvider({ store }));
        }
        catch (error) {
            // A discovery surface is not worth failing the plugin for. Log and
            // carry on: the shell-env channel and the settings page are intact.
            logger?.warn?.(`dsh-key-panel: could not publish MCP resources (${error?.message ?? error})`);
            return;
        }
        logger?.info?.(`dsh-key-panel: published MCP resource server "${SERVER_NAME}"`);
        // `mcpResources.register` owns its effect on the SERVICE's context, not
        // the caller's, so the provider would outlive this plugin if the
        // disposer were dropped. Tie it to the injection's own fiber instead.
        inner.effect(() => () => dispose?.());

        // The host lists the server NAME in its own MCP section; this sentence
        // is what tells the model the name belongs to the key panel and that the
        // surface is metadata-only. Registered only on the path where the server
        // was genuinely published, so the prompt cannot advertise a missing
        // interface.
        //
        // Deliberately the OUTER ctx, not `inner`: `systemPrompt` is declared in
        // the plugin's own inject array, so it is guaranteed present here, while
        // reaching for it on the mcpResources-scoped context would depend on
        // inheritance and is exactly the shape that threw under cordis 0.2.0-rc.2.
        ctx.systemPrompt?.section?.({
            name: PROMPT_SECTION,
            order: PROMPT_ORDER,
            text: PROMPT_TEXT,
        });
    });
}
