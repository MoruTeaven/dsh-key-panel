# dsh-key-panel

`@moruteaven/dsh-key-panel` on npm · **English** · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md)

A secret store for [DSH Desktop](https://deepseek.com). Keep API keys in one
place, have them injected into the assistant's shell as `$DSH_*` variables, and
decide — from a settings-page panel — exactly how much the assistant is allowed
to do with them.

The problem this solves: an assistant that needs to call Cloudflare, or OpenAI,
or your database needs a credential. Pasting it into the conversation puts it in
the transcript forever. Sending it as a file means it lands in some directory you
forget about. This puts it in one file, exposes it as an environment variable,
and never lets the value enter the conversation at all.

```
Assistant needs to deploy a Worker
  → writes: wrangler deploy --api-token $DSH_CLOUDFLARE_TOKEN
  → the shell has it; the model's context never does
```

---

## Features

- **Settings-page panel.** Add, edit, reveal, copy and delete keys where you
  already manage the rest of the app. No config file editing.
- **`$DSH_*` injection.** Every key becomes a variable in the assistant's shell.
  Changes take effect on the next command — no restart.
- **Three access modes**, chosen by you and persisted:
  `readonly` (default) · `write` · `edit`.
- **Platforms and accounts.** Most providers need two values (an account id and
  a token), and one provider often has several accounts. Group keys under a
  platform and an account; each slot becomes `DSH_<PLATFORM>_<ACCOUNT>_ID` and
  `DSH_<PLATFORM>_<ACCOUNT>_KEY`. Grouping is only a way to organise storage —
  the variable names stay flat, and so does everything that reads them.
- **Provenance tracking.** Keys record whether *you* or the *assistant* created
  them, and a write cannot launder one into the other.
- **Recent activity.** A log of what each shell command was handed, alongside the
  purposes the assistant chose to declare. The two are shown together, never
  paired. Names and timestamps only — no value is ever written to it.
- **Optional name scope.** Restrict the assistant to names matching `DSH_AGENT_*`
  and nothing else.
- **Two-phase deletion.** Deleting needs a second, confirmed call with a
  short-lived token — a single stray tool call cannot remove a key.
- **Values never reach the model.** No tool returns a key value, in any mode.
- **Idempotent, hot-reload safe.** The panel re-reads policy on every call.

## Install

```
Settings → Plugins → search "dsh-key-panel" → Install → restart DSH Desktop
```

The panel then appears in **Settings → Keys**.

Other channels:

- **npm** — `npm i @moruteaven/dsh-key-panel`, then add the bare package name
  `@moruteaven/dsh-key-panel` to `dsh.profile.bundles` in your profile's
  `package.json`. The bundles list takes **bare package names only**; a `file:`
  or path spec is rejected there (`file:` is fine in `dependencies`).
- **From source** — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Usage

### Add a key

Settings → Keys → **Add key**.

| Field | Notes |
| --- | --- |
| Name | Must match `DSH_[A-Z][A-Z0-9_]*` — e.g. `DSH_CLOUDFLARE_TOKEN` |
| Purpose | Optional. Shown to the assistant as the variable's description. |
| Value | The secret. Stored plaintext; shown masked afterwards. |

Then tell the assistant to use it:

> Deploy the worker, the token is in `$DSH_CLOUDFLARE_TOKEN`.

### Platform and account

When a provider wants two values — an account id and a token, say — and you have
more than one account with them, the flat list gets hard to read. **Add platform**
and **Add account** group those keys and name them for you:

| You enter | You get |
| --- | --- |
| platform `CF`, account `WORK` | `DSH_CF_WORK_ID` and `DSH_CF_WORK_KEY` |

The panel shows both names before you commit, so you can see what will land in
the shell. Identifiers are uppercase letters, digits and underscore; lowercase is
rejected rather than silently uppercased, because a name you did not ask for is
worse than one you have to retype.

Each platform and account also takes a **display name**, which is what the panel
shows. It is separate from the identifier on purpose: identifiers are baked into
variable names and cannot be changed afterwards, while display names are yours to
edit at any time. If you want a platform to read as "Cloudflare" while its
variables stay `DSH_CF_*`, that is exactly what the two fields are for.

If the names an account would produce are already taken — you added
`DSH_CF_WORK_KEY` by hand before creating that account — the panel says so and
asks before continuing, naming the keys involved. Saving over them would replace
their values, so it is not done silently.

Two things worth knowing:

- **Grouping is organisation, not security.** The variables are ordinary flat
  `DSH_*` names — that is the whole point, since a shell has no nesting. What
  grouping buys you is a readable panel and, incidentally, a scope that lines up
  with one account (see below).
- **Deleting a platform or account will not take your secrets with it.** If keys
  are still filed under it the delete is refused; you clear or re-file them
  first. If you ask it to go ahead anyway, the keys are un-filed — moved back to
  the ungrouped list — and their values are untouched.

Keys you never filed stay exactly as they were. Nothing has to be reorganised for
this feature to be useful, and an existing store keeps working unchanged.

### Recent activity

The panel keeps two records, and puts them side by side:

| Record | Written by | Contains |
| --- | --- | --- |
| **declared** | the assistant, calling `key_panel_intent` | a timestamp it says a purpose, and the names it means to use |
| **handed to command** | the plugin itself, every time a shell command is resolved | a timestamp and the names that went into that command |

They are **shown together, not paired**. An intent and a use that sit near each
other in the list may belong to the same task, but nothing in the data says so,
and joining them would be a guess presented as a fact.

**What "handed to command" does not mean.** The host resolves the whole
`$DSH_*` environment before every shell command and cannot see what the command
does with it. So a row means those names *were in scope at that moment* — never
that the command read them, and never what it did with them. Treat the log as a
signal about which credentials a workflow depends on, not as an audit trail.

Two practical consequences of that:

- **The assistant may declare nothing.** `key_panel_intent` is optional and
  skipping it costs nothing, so expect undeclared activity. The plugin asks for
  intent where it is cheap, but never requires it — a required step in front of
  every command would turn into a reflex and stop carrying information.
- **Costs are off the command path.** Records are buffered in memory and written
  in batches, so logging never slows down a command. The log is capped (oldest
  entries are dropped) and a write failure is swallowed — losing the tail of
  this file costs a trend, not a secret.

The log lives beside the key store in `usage.jsonl` and holds **names and
timestamps only. No value is ever written to it.**

### Access modes

| Mode | Assistant can | Assistant cannot |
| --- | --- | --- |
| `readonly` *(default)* | use keys | change anything — no write tool is registered |
| `write` | add keys; replace keys it created | delete anything; edit your keys |
| `edit` | add, change, delete | — (delete still needs confirmation) |

Set it in the panel. It applies to the next tool call, no restart.

**Start at `readonly`.** Move up only when you actually want the assistant adding
its own credentials — that is the one workflow the other two modes exist for.

### Restrict by name

The optional scope field limits the assistant to matching names:

| Value | Effect |
| --- | --- |
| *(blank)* | no restriction |
| `DSH_AGENT_*` | only names with that prefix |
| `DSH_CF_*` | only that platform's keys |
| `DSH_CF_WORK_*` | only one account's credentials |

A single `*` is the only metacharacter. It cannot express a path or a regex.

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Access mode | Panel | `readonly` |
| Name scope | Panel | unrestricted |
| Store location | `$DSH_HOME/key-panel/keys.json` | `~/.dsh/key-panel/keys.json` |
| Activity log | `$DSH_HOME/key-panel/usage.jsonl` | `~/.dsh/key-panel/usage.jsonl` |

## Storage format

```jsonc
{
  "version": 2,
  "policy": { "accessMode": "readonly", "scopePattern": null },
  "platforms": {
    "CF": { "label": "Cloudflare", "createdAt": 1758428400000 }
  },
  "accounts": {
    "CF/WORK": { "platform": "CF", "identifier": "WORK", "label": "Work", "createdAt": 1758428400000 }
  },
  "keys": {
    "DSH_CF_WORK_TOKEN": {
      "value": "…",
      "description": "Cloudflare Workers deploy token",
      "origin": "operator",        // "operator" | "model"
      "platform": "CF",            // optional grouping
      "account": "WORK",
      "field": "key",              // "id" | "key"
      "createdAt": 1758428400000,
      "updatedAt": 1758428400000
    }
  }
}
```

Writes go through a temp file + `fsync` + rename, so a crash cannot leave a
renamed-but-empty file behind — which would read back as "all keys deleted".

A version 1 file loads as-is: the grouping fields are optional, so keys written
before platforms existed simply read back as ungrouped. No migration step.


### `usage.jsonl`

Activity records live in a **separate file**, one JSON object per line:

```jsonc
{"t":1758428400000,"kind":"intent","names":["DSH_CF_WORK_TOKEN"],"note":"deploy staging"}
{"t":1758428450000,"kind":"use","names":["DSH_CF_WORK_TOKEN"]}
```

| Field | Meaning |
| --- | --- |
| `t` | epoch milliseconds |
| `kind` | `intent` (assistant-declared) or `use` (handed to a command) |
| `names` | `DSH_*` names involved, deduplicated. **Never a value.** |
| `note` | intent only — the purpose, trimmed to 500 characters |

It is appended in batches and capped at the most recent 1000 entries, so it
cannot grow without bound. Unlike `keys.json` it is **not** written atomically
and **not** fsynced per line: a hard kill can truncate the final line, which
readers skip. That is the correct trade here — this file is a signal, not a
secret, and paying for durability would slow down every command.

Because the two kinds are written by different parties at different moments,
they are stored as separate entries and correlated by timestamp when displayed.
The plugin never joins them.

## Security

**Values are stored in plaintext.** This is deliberate and explained in full in
[SECURITY.md](./SECURITY.md), along with the trust model, the invariants, and the
non-goals.

The short version:

- Anything running as your OS user can read the store. Treat it like an `.env`.
- The assistant can never read a key value into its transcript, in any mode.
- The assistant can never change the access mode or the scope — those are
  operator-only.
- In `readonly`, the write tools do not exist rather than refusing.

## Development

```bash
npm test          # both suites — 180 assertions
npm run test:host # host half: policy, store, tools, gateway (139)
npm run test:client # client bundle: contract, slots, RPC, dictionaries (41)
```

The client suite loads `lib/client.js` the way the real frontend does — a fake
`window.__ModuleLoader__`, seed-word-only `require` — and asserts the bundle
registers without side effects, that only seed modules are required, and that
every RPC endpoint the panel calls matches the gateway.

No build step. Plain ESM on the host, a CJS factory string in the browser.

```
lib/
  policy.js   access modes, scope glob, decision function
  store.js    persistence, provenance, atomic write
  tools.js    model-facing tools, confirmation ledger
  index.js    host half — Typert gateway, shellEnv registration
  client.js   browser bundle — settings panel
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the conventions this repo enforces
and how to run the suites.

## Compatibility

- DSH Desktop 2.0.11+ (dsh `0.1.5-rc.1`)
- Node 20+
- Client half: web platform only

## License

[Apache License 2.0](./LICENSE) · attribution in [NOTICE](./NOTICE)

Apache-2.0 was chosen over MIT/BSD for this project because it adds two clauses
that matter for a tool handling credentials:

- **A patent grant** (§3), which MIT and BSD lack entirely — and it obliges
  contributors to grant the same.
- **A trademark limitation** (§6), so the authors' names cannot be used to
  endorse a fork. That is the same protection BSD-3-Clause's endorsement clause
  gives.

Everything else is permissive: use it commercially, modify it, ship it closed.