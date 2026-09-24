# Security Policy

## What this plugin is

`@moruteaven/dsh-key-panel` is a secret store for a single-user desktop application. It keeps
API keys on the local disk, injects them into the assistant's shell environment as
`DSH_*` variables, and gives the operator a settings-page panel to manage them.

It is a **convenience and blast-radius tool, not a security boundary against a
local attacker.** Read the trust model below before deciding whether it fits your
threat model.

## Trust model

| Party | Trusted? | Notes |
| --- | --- | --- |
| The operator (you) | Yes | Owns the machine and the panel. Full read/write. |
| The assistant (model) | **No** | Untrusted. Its authority is whatever the operator grants, per call. |
| Other processes on the machine | **No** | Same OS user can generally read the store file. |
| The plugin code itself | Yes, by installation | Runs inside the host process with full privileges. |

## Storage: plaintext, and why

Values are stored **unencrypted** in JSON:

```
$DSH_HOME/key-panel/keys.json
```

Default on Windows: `C:\Users\<you>\.dsh\key-panel\keys.json`

This is a deliberate trade-off:

- **The value has to reach a shell environment variable.** Whatever encrypts it
  must be able to decrypt it unattended, at every command execution, with no
  operator present. Any key that can do that is itself a secret sitting on the
  same disk — encryption would add a step, not a boundary.
- **OS keychains need an interactive unlock** and would break headless or
  background runs. That is a real availability cost for a threat it does not
  actually stop.
- **The realistic threat is accidental exposure**, not disk forensics. A threat
  model of "someone has my unlocked disk" is already lost before this plugin runs.

What this means in practice:

- Anything running as your user can read the file. That includes other editors,
  scripts, and any plugin you install.
- Your backups, cloud-sync folders, and disk images will contain the plaintext.
- Restrict the file yourself if you want defence in depth:

  ```powershell
  icacls "$env:USERPROFILE\.dsh\key-panel\keys.json" /inheritance:r /grant:r "$env:USERNAME:(R,W)"
  ```

## Access modes — the core control

The operator picks one mode in the panel. It is persisted, and it takes effect on
the next tool call **without a restart**. Default:

| Mode | The assistant can | The assistant cannot |
| --- | --- | --- |
| `readonly` *(default)* | use keys in commands | change anything — **no write tool is registered at all** |
| `write` | create a key; replace a key it created | delete anything; modify operator-created keys |
| `edit` | create, replace, delete | — (deletion still needs a second confirmation) |

### Why `readonly` removes the capability instead of refusing it

In `readonly` mode no `key_panel_set` / `key_panel_delete` tool is registered at
all. A refusal-based implementation still puts the tool in the model's context;
absence does not. An argument about permissions is a thing a model can be talked
out of, and a tool that exists is a tool that can be mis-invoked. There is no
prompt that reveals a capability that was never registered.

### Provenance, and what it does and does not prevent

Each key records who created it:

- `origin: "operator"` — made in the panel.
- `origin: "model"` — made by the assistant.

**Provenance follows the creator, not the last writer.** When the assistant
overwrites a key it created, the origin stays `model`. When it writes to an
operator key in `write` mode, the origin stays `operator` — the write is allowed,
but it cannot launder the key into its own namespace and then delete "its own"
key. Deletion in `write` mode is refused for *all* keys regardless of origin, so
there is no sequence of writes that unlocks deletion.

**Provenance is a `write`-mode control, and `edit` mode does not apply it.**
This is deliberate and worth stating plainly, because it is the one place the
mode table above is doing real security work:

| Mode | Replacing the value of an operator-created key |
| --- | --- |
| `write` | **Refused** — the check above is what enforces it |
| `edit` | **Allowed**, with no provenance check |

So "the assistant cannot overwrite a key you created" is a property of `write`,
not of the plugin. Choosing `edit` grants it, because `edit` already grants
deletion of the same key — a mode that permits destroying a secret but not
changing it would be a boundary in name only. The remaining guard on replacement
in `edit` mode is the scope restriction, if one is set. Treat `edit` as "the
assistant may do anything to any key in scope", which is what the table says.

### Scope restriction

The optional `scopePattern` is a second, independent limit on which names the
assistant may touch — for example `DSH_AGENT_*`. It is a single-metacharacter
glob (`*`), not a regex, and it can only express `DSH_`-prefixed names. It cannot
be used to reach a path or a non-key resource.

**As shipped, the panel does not offer a control to set it.** The mechanism
itself is complete and enforced: the value is validated, persisted, re-read on
every model call, and a scope already present in the store keeps applying. What
is absent is the field that *writes* it, which is hidden behind the
`SHOW_SCOPE_UI` flag in `lib/client.js`. Set it by hand in the store file, or
flip the flag, to use it.

This is a deliberate release decision, not an oversight, and it has a security
consequence worth being explicit about: **out of the box, the only thing
bounding which keys the assistant may touch is the access mode.** If you want a
scope, you must set one yourself. An unset scope means no restriction — the
assistant reaches every key the mode allows.

### Changing the mode is operator-only

`setPolicy` is exposed on the panel's RPC surface and is **never** exposed as a
model tool. The assistant cannot widen its own access, cannot read the mode to
reason about it in `readonly`, and cannot disable the scope restriction. Only a
human clicking in the settings page can move the boundary.

## Invariants the implementation holds

These are asserted by the test suite (`node test/run.mjs`):

1. **No tool ever returns a key value.** Tools return names, descriptions and
   status only. The value's only route to the assistant is the shell environment,
   referenced as `$NAME` — it never enters the conversation transcript.
2. **Deletion is two-phase.** The first call mints a random token and changes
   nothing; removal requires a second call carrying that exact token. Tokens are
   held in memory only — a restart invalidates every outstanding one — expire
   after 5 minutes, and are superseded when a newer request arrives for the same
   name. A mode change also clears all pending tokens.
3. **A bad policy update is rejected, never silently degraded.** `setPolicy`
   validates and throws; the previous policy is left untouched. (An earlier
   revision normalised an unknown mode to `readonly` *and wrote it*, so a typo
   both looked successful and destroyed the real setting.)
4. **Reading persisted state is lenient, accepting new state is strict.** A
   corrupt or hand-edited store file degrades to a safe default rather than
   crashing the host, because a plugin that fails to load takes the whole plugin
   tree into recovery mode.
5. **Policy is re-read on every tool call**, so a mode change applies to the very
   next call and cannot be raced.

## Known risks and non-goals

- **Plaintext at rest** — see above. This is the main one.
- **No protection against a malicious plugin.** Any installed plugin runs in the
  same process with the same file access. Do not install plugins you do not trust.
- **Values are visible to the shell.** Anything that logs the environment, or a
  command that echoes the variable, leaks it. `set -x`, `env`, and CI-style
  debug output are the usual culprits.
- **No rotation, expiry, or audit log.** Keys are static until you change them.
- **Not multi-user.** The store is per `DSH_HOME`; there is no per-user isolation.
- **The panel reveals values in the UI on request.** That is intentional — the
  operator must be able to retrieve a key — but it means a screenshot or a
  shoulder-surfer matters. Values are masked by default.

## Reporting a vulnerability

Open a private security advisory on the repository. Please do not open a public
issue for anything that could expose a stored key.

Include: affected version, the mode in effect, and a minimal reproduction. A
report that shows the assistant obtaining a key value in its transcript, or
widening its own access mode, is the highest severity class for this project.

Expect an acknowledgement within a few days. This is a hobby-scale project with
no bug bounty — but a real finding will be credited in the fix.
