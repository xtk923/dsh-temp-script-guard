# dsh-temp-script-guard

The `temp-script-manager` skill, upgraded from advice into enforcement.

A skill can only **ask** the model to keep throwaway scripts out of the project.
This plugin makes it happen: a `tools/pre-execute` guard refuses a `write`/`edit`
whose target looks like a scratch script and lives outside the managed
directory, and the `temp_script_*` tools own the lifecycle the skill used to
describe in prose.

## What it does

| Piece | Behaviour |
|---|---|
| **Guard** | Refuses `write`/`edit` of a `*.py`, `*.sh`, `*.ps1`, `*.js`, `*.ts`, … whose name carries a `tmp` / `temp` / `scratch` / `one-off` / `wip` … segment *and* sits outside the managed directory. The refusal names the fix, so the model recovers in one step. |
| `temp_script_save` | Writes into `~/tools/temp-scripts/` as `YYYYMMDD-HHMMSS_slug.ext`, creating the directory. Never overwrites: a same-second save gets `-2`, `-3`, … |
| `temp_script_list` | Newest first, with size, age in days, and an `expired` flag past the configured age. |
| `temp_script_purge` | Deletes scripts at or past the expiry age. **Dry run by default**; `dryRun: false` to delete. Only ever touches the managed directory. |
| `temp_script_promote` | Moves a keeper out to `~/tools/`, dropping the timestamp prefix. |

Left alone on purpose: the OS temp directory, `node_modules`, `.git`, `dist`,
`build`, `target`, `.venv`, `.cargo`-style output trees, non-script extensions
(a `tmp_notes.md` is a document, not a script), and file names that merely
resemble a scratch token (`attempt.py`, `template.py`, `latest.sh`).

## Configuration

Set in the bundle patch ([cordis.patch.yml](cordis.patch.yml)) or a profile
override:

```yaml
- id: temp-script-guard
  config:
    mode: deny                  # deny (default) | off
    managedDir: ~/tools/temp-scripts
    toolsDir: ~/tools
    olderThanDays: 7
    excludedDirs: []            # extra directory names to leave alone
```

`mode: off` keeps all four tools and stops refusing writes — useful when a
session legitimately works on files named `tmp_*`.

## Install

```bash
dsh plugin --profile desktop add link:C:/Workspace/dsh-temp-script-guard
```

then add `dsh-temp-script-guard` to `dsh.profile.bundles` in the profile's
`package.json`. On this machine both steps were done by the plugin manager, so
the profile already reads:

```json
"dependencies": { "dsh-temp-script-guard": "link:C:/Workspace/dsh-temp-script-guard" },
"dsh": { "profile": { "bundles": [ "...", "dsh-temp-script-guard" ] } }
```

The dependency is a **junction** to this directory, so editing `src/index.js`
is picked up by the next load without reinstalling — but deleting this
directory breaks the profile's plugin.

## Verify

```bash
node --test test/            # 13 tests: policy, naming, tools, guard, rendering
```

Live checks after installing: `temp_script_save` creates a timestamped file,
`temp_script_list` reports it, and a `write` to `<project>/tmp_x.py` is refused
while `<project>/guard_test_fixture.py` goes through.

## Design notes

* The guard is a `ctx.tools.guard`, not the `tools/pre-execute` waterfall:
  a guard is synchronous, cannot be force-allowed by a later listener, and a
  returned string is the denial. It never throws — a throw would be a policy
  failure for an unrelated tool call, so every branch is wrapped.
* `inject: ['tools']` only. Everything else is a Node built-in, so this plugin
  cannot leave a composition pending on a service the profile does not mount.
* Path comparison is case-folded on Windows, and containment is checked with a
  separator-aware prefix so `Demo` does not match `Demolish`.
