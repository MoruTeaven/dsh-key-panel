# AGENTS.md — dsh-key-panel

This is the repo where the plugin is written. `lib/` is the whole source — plain
ESM on the host, a CJS factory string in the browser, **no build step**.

Everything an agent needs is in this file and in `CONTRIBUTING.md` right beside
it. Start there for how to run the suites and what the repo enforces.

## First thing to know

This is a plugin for DSH Desktop, and the plugin system is not forgiving about
its manifest: a mistake here fails at **startup**, not at install, and takes the
app into recovery mode. Two consequences for how you work:

- **Static checks before restarts.** `CONTRIBUTING.md` lists them. A restart
  cycle is expensive and a throw in `apply()` is not recoverable from inside the
  app.
- **The three-name rule is not a style preference.** `package.json` `name`,
  `cordis.patch.yml` insert-row `name`, and the id in `lib/client.js` must be
  byte-identical. A mismatch shows up as a settings panel that silently never
  appears.

## Layout

```
lib/
  policy.js   access modes, scope glob, the single authority on the model's reach
  store.js    persistence, provenance, atomic write
  tools.js    model-facing tools, confirmation ledger
  index.js    host half — Typert gateway, shellEnv registration
  client.js   browser bundle — settings panel
test/
  run.mjs     host suite
  client.mjs  client bundle suite
```

## Where to look for depth

- `SECURITY.md` — trust model, invariants, non-goals. Read it before changing
  anything about how values move.
- `CONTRIBUTING.md` — conventions, how to run the suites, how to install from
  source, what "done" means. Its **Release channels** section is required
  reading before any publish: a bare `npm publish` goes to the private Codeup
  repo, and a 403 from it means the wrong credential, not a value that failed
  to arrive.

## Open items

Add new issues to this workspace's taskboard rather than growing a list here.
