# Contributing

## No build step

The files in `lib/` are what ships. Plain ESM on the host (Node 20+), a lazily
executed CJS factory string in the browser. Edit, then run the suites.

```bash
npm test          # both suites
npm run test:host # host half: policy, store, tools, gateway
npm run test:client # client bundle: contract, slots, RPC, dictionaries
```

The suites are dependency-free — `lib/policy.js` and `lib/store.js` import nothing
but `node:` builtins, and the client suite loads the browser bundle against a
stubbed loader. They load host packages (`@deepseek-ai/*`) through
`node_modules/`, so a fresh clone needs those resolvable before `npm test`
passes; see below.

## Conventions

### Two halves, two styles

- `lib/policy.js`, `lib/store.js` — import `node:*` and nothing else. They are the
  pure core, which is what keeps them testable without the app running.
- `lib/tools.js` — the model's face. Every tool is registered inside the **mode
  gate** (`readonly` registers none: the capability is absent, not refused), and
  the policy is re-read at call time via `livePolicy()`, never from a captured
  copy.
- `lib/index.js` — the host's face. A new gateway method stays unreachable until
  its name is appended to the `markRemoteMethods(KeyPanelGateway, [...])` list
  that sits just above `apply()`; the omission is silent.
- `lib/client.js` — not an ES module: one lazily-executed CJS factory string,
  **tab-indented** (every other file here uses 4 spaces). The body only
  registers; side effects belong inside the factory.

### The invariant that outranks the rest

No model-facing tool result carries a key value. The shell environment the host
fills itself is the only channel a secret travels through. A debug echo, a
`preview` field, a value in an error message — any of them puts the secret in
the transcript, the one outcome this plugin exists to prevent. Trust model,
invariants and non-goals: [SECURITY.md](./SECURITY.md).

### One name, three places

`package.json` → `name`, `cordis.patch.yml` → insert row `name`, and
`lib/client.js` → `__ModuleLoader__.load({ id })` must be byte-identical. Group
[9] of `npm run test:client` checks all three against `package.json`, so a
partial rename goes red in the suite rather than at startup as a settings panel
that never appears. The row's other field, `id: key-panel`, is the patch-layer
toggle key and deliberately differs from the package name.

### One string, three homes

A user-visible string lives in three places, and a change lands in all of them in
the same commit:

1. the `zh` / `en` dictionaries in `lib/client.js` — key-for-key identical; group
   [7] of the client suite catches a missing key, which otherwise renders as a
   raw identifier in the UI.
2. `README.md`, `README.zh-CN.md`, `README.ja.md` — nothing checks this one, so
   syncing by hand is the job.
3. model-facing tool descriptions in `lib/tools.js` — English only.

## Driving it by hand

Point every manual run at a scratch store: `apply(ctx, { storePath: '<tmp>/keys.json' })`.
The live store is `$DSH_HOME/key-panel/keys.json` — real operator secrets; keep
it out of runs, logs, commits and replies. Writes there are atomic on purpose
(tmp + `fsync` + rename), so a hand-rolled write is a regression.

## Installing from source

The plugin must resolve from your profile's `node_modules` **by its bare package
name**, and the profile must list it in `dsh.profile.bundles`.

- `dsh.profile.bundles` takes **bare package names only**. A `file:` or path spec
  is rejected there — link the package instead so the name resolves. `file:` is
  fine in `dependencies`.
- Every bundle must ship a `dsh.bundle.patch` entry in its `package.json`,
  pointing at a real file. This package ships one.
- A local install directory does **not** inherit the host's dependency tree. Every
  `@deepseek-ai/*` package the plugin imports needs its own link into this
  package's own `node_modules/`, or startup fails with `ERR_MODULE_NOT_FOUND`.
  Cross-check the list against what the code actually imports:

  ```bash
  grep -rho "from '@deepseek-ai/[^']*'" lib/ | sort -u
  ```

  Then confirm each one resolves before restarting:

  ```bash
  node -e "
  const { createRequire } = require('module');
  const req = createRequire(process.cwd() + '/lib/index.js');
  for (const s of ['@deepseek-ai/cordis','@deepseek-ai/dsh-home-paths','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-typert-protocol']) {
    try { req.resolve(s); console.log('  OK   ' + s); }
    catch { console.log('  FAIL ' + s); }
  }
  "
  ```

## Release channels

Which registry a publish lands on is decided by `~/.npmrc`, not by the shell
the panel injects into.

- **Private (Codeup) is the default.** `@moruteaven` is bound there, so a bare
  `npm publish` authenticates with that file's own `_authToken`; the injected
  `$DSH_NPM_*` value takes no part in it. A dry run states the target outright:

  ```bash
  npm publish --dry-run
  # npm notice Publishing to https://packages.aliyun.com/<org>/npm/dsh-key-panel/ …
  ```

- **Public (npmjs) needs the scope overridden.** The binding outranks both
  `--registry` and `NPM_CONFIG_REGISTRY` — either one alone is silently
  ignored for this scoped package and the publish still goes to Codeup — so
  override the scope itself, and ask for `public` because a scoped package
  defaults to `restricted`:

  ```bash
  npm publish --@moruteaven:registry=https://registry.npmjs.org/ --access public
  ```

  The same override also works as an environment variable
  (`NPM_CONFIG_@MORUTEAVEN:REGISTRY=…`), which is what makes it scriptable.

  Prereleases are private-only: they go to Codeup under `--tag dev` (snapshot
  at 1.0.2-dev.2: `latest=1.0.1`, `dev=1.0.2-dev.2`), and never to npmjs. The
  public channel carries formal versions and nothing else — reaching for the
  scope override above is how a release crosses that line, so don't.

### A 403 means the wrong credential, not a lost value

An npmjs PAT aimed at Codeup answers 403 even when `shellEnv` delivered the
value byte-perfectly — that is an identity mismatch, not an injection failure.
Check who the credential belongs to (`npm whoami --registry=…`) before
suspecting the shell. The panel stays registry-agnostic by design (see
`SECURITY.md`); the practical rule is one key per registry under a name that
says which (`$DSH_NPM_NPMJS_KEY` vs `$DSH_NPM_CODEUP_KEY`). npm never reads
`$DSH_*` on its own — bridge an injected value into a config npm does read
(`--userconfig` pointing at a scratch file outside the repo), and never pass
`--_authToken=` on a command line, where the value lands in the process list
and shell history.

Only formal versions reach the public channel; `-dev` builds stay private.

## Done means

- `npm test` green — both suites.
- For packaging edits, run the manifest assertions in
  `.github/workflows/test.yml` locally — they are plain `node -e` checks.
- Release-worthy changes bump `version` in `package.json`.
