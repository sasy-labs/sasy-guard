# sasy-guard

Claude Code plugin enforcing SASY Datalog policies on tool calls.

Four hooks, nothing else: `SessionStart` (ensure the `sasy-watch` daemon,
register the session, pin the policy profile), `SessionEnd` (deregister),
`PreToolUse` (check every tool call via the daemon → `RMProxy.CheckToolCall`;
denied calls block with a `[SASY]` reason, even in bypassPermissions mode), and
`PostToolUse` (signal that an `@ask`'d tool ran — a marker-independent approval
for the detaint recorder). Fail-closed: if the daemon is unreachable after one
respawn attempt, tool calls are blocked (`SASY_FAIL_OPEN=true` to override).

Enforcement reference (integration, RPCs, `@ask`, policy design + Datalog):
[`docs/claude-code-enforcement.md`](../../docs/claude-code-enforcement.md) ·
Design: [`docs/claude-code.md`](../../docs/claude-code.md) ·
Daemon: [`packages/claude-code/`](../../packages/claude-code/)

Live demo: `make claude-code-demo` (builds everything, installs the plugin
config, launches an enforced Claude Code session). Persistent per-project setup:
`make claude-code-init PROJECT=/path` (or `init-project.sh`) writes the project's
`.claude/settings.json` so plain `claude` is enforced there. Multi-platform
release bundles: `.github/workflows/claude-code-release.yml` +
`scripts/build-claude-code-release.sh`.

## Try it (repo dev mode)

```sh
# 1. Policy engine (from repo root; binary per CLAUDE.md build)
SASY_ALLOW_NO_AUTH=1 sasy-services/target/release/sasy serve \
  --evaluator souffle --addr 127.0.0.1:50061 \
  --auth-config config/auth_config.yaml --data-dir /tmp/sasy-data

# 2. Daemon config
mkdir -p ~/.sasy && cat > ~/.sasy/config.json <<EOF
{ "endpoint": "localhost:50061", "insecure": true, "entity": "copilot",
  "failMode": "closed",
  "policyPath": "$PWD/plugins/sasy-guard/profiles/security.dl" }
EOF

# 3. Build the daemon and run a guarded session
(cd packages/claude-code && bun install && bun run build:binary)
claude --plugin-dir plugins/sasy-guard

# Inside the session: `rm -rf` and force pushes are denied with a [SASY] reason.
```

## Profiles (`profiles/`)

- `security.dl` — the unified policy: fifteen independently-toggleable
  rule groups (data_loss, secret_scan, exfil, toxic_flow, reverse_shell,
  config_persistence, guard_config, agent_redirect, curl_sh, hidden_unicode,
  public_push, review_gate, supply_chain, dep_scan, sast), all ON by default
  (`sast` stays inert until a results file is configured). The old
  `rm-rf-block`, `taint-untrusted-fetch`, and `supply-chain` profiles are now
  groups here.
- `allow-all.dl` — observe-only
- `deny-all.dl` — lockdown (the engine bootstrap posture)

Select via `policyPath` in `~/.sasy/config.json` (pinned per session at
SessionStart; the server dedupes identical sources by content hash). Dial
coverage **without editing the policy** via metadata flags — `rule_off <group>`
to drop a group, or `rule_on <group>` for opt-in mode (e.g. `rule_on data_loss`
reproduces the old `rm-rf-block`). See
[`docs/claude-code-enforcement.md`](../../docs/claude-code-enforcement.md) §4.

## Settings (`~/.sasy/config.json`)

Every knob below already exists in the daemon. They were undocumented here, which
is how a field test concluded the tuning did not exist at all — so this table is
the reference, and adding a setting means adding a row.

| Key | Default | What it does |
|---|---|---|
| `failMode` | `"closed"` | `closed` blocks when the engine is unreachable; `open` allows. `SASY_FAIL_OPEN=true` forces `open`. **Managed: locked by presence, final** for the daemon — while any managed file applies, a local `open` and `SASY_FAIL_OPEN` are ignored whether or not the file names this key; when it does, a managed `open` still yields to a local `closed`. It does **not** reach the hooks: when the *daemon* is unreachable the hook decides on its own, reading `SASY_FAIL_OPEN` from its environment, so that variable still lets a call through there. |
| `ruleOff` | `[]` | Rule groups to disable (subtractive; everything else stays on). **Managed: whole list, and locked by presence** — a managed list (`[]` included) replaces the local one, so a group it leaves on cannot be turned off locally; and while any managed file applies, a local `ruleOff` is not read at all, so the built-in default (every group runs) is what stands when the file names none. That is what keeps the other locks meaningful: a `sastSeverityActions` floor over a `sast` group switched off locally would decide nothing. `/healthz` and `status` print the groups that actually run next to the locked keys. |
| `ruleOn` | `[]` | Opt-in mode: when non-empty, **only** these groups run — so one entry switches fourteen groups off. **Managed: whole list, and locked by presence** — a local `ruleOn` is ignored under a managed `ruleOff`, unioned (more checks) when the managed file uses `ruleOn` itself, and dropped outright when the managed file names neither. |
| `cooldownDays` | `7` | Supply-chain cooldown. A release younger than this asks, unless OSV records it as a security fix. **Managed: maximum** of the managed and local values, **and locked by presence one-directionally** — with no managed value, a local window shorter than the policy default of 7 days is dropped and a longer one still stands. |
| `reviewDiffLines` | `150` | Re-review threshold for code **no review has seen**, in changed lines against everything unpushed. **Managed: minimum** of the managed and local values, **and locked by presence one-directionally** — with no managed value, a local threshold higher than the in-policy default of 150 is dropped (a `reviewDiffLines` of 99999 is how this gate is switched off) and a lower one still stands. |
| `reviewFixDiffLines` | `500` | Re-review threshold for changes made **since a review**, measured from that review. Deliberately looser — a fix answering review findings carries its test and docs in the same change. **Managed: minimum** of the managed and local values, **and locked by presence one-directionally** — with no managed value, a local threshold higher than the in-policy default of 500 is dropped (a `reviewFixDiffLines` of 99999 is how this gate is switched off) and a lower one still stands. |
| `reviewEditThreshold` | `800` | Fallback threshold in edited characters, used **only** outside a git repo. Does not apply to normal pushes. **Managed: minimum** of the managed and local values, **and locked by presence one-directionally** — with no managed value, a local threshold higher than the in-policy default of 800 is dropped (a `reviewEditThreshold` of 99999 is how this gate is switched off) and a lower one still stands. |
| `trustedDomains` | `[]` | Hosts whose install scripts may be piped to a shell. Entries must be **registrable domains** (`brew.sh`, not `sh.brew.sh`). Empty means every `curl … \| sh` asks. **Managed: allowlist, and locked by presence** — the managed list is taken whole, a local list is ignored, and with no managed list the empty default applies rather than the local one. |
| `sastSarifPath` | unset | Where your static analyser writes SARIF. Unset means the `sast` group is inert. |
| `sastSeverityActions` | `{}` | Severity → `"block"` or `"ask"`. Unlisted severities are ignored. **Managed: floor**, and the managed table is validated first — bands must be `critical`/`high`/`medium`/`low` and actions `block`/`ask`, or the whole key is refused (reported as `invalidKeys`) and the local table stands, because a typo'd band or action would floor nothing while `status` printed the floor sentence (a band whose value is not a string at all — `{"high": {"toString": 5}}` — is refused the same way, in the managed file and in `config.json` alike) — a lower source (including a project's `.sasy/project.json`) may add a band or raise `ask` to `block`, never the reverse; on a managed band a local value that is not `block` or `ask` is refused rather than written, so it cannot delete the band. The floor covers the **action tables only**: a project's `gate.demote` regrades findings to `low` before the table is read, `.sasy/overrides.json` removes them by fingerprint, and (with `sastCommand` pinned) the committed `scan` block decides what is scanned — none of the three is floored, so a managed band can end up with no findings in it. A floor is also not a scan: pinned on its own it does not govern `sastSarifPath`, `sastCommand` or `sastScope`, so it grades whatever scan the local configuration runs — or nothing, when none is configured (`sastScanSource` says which). What stands against them is the `sast_project_changed` ask on the push carrying that commit. |
| `sastScope` | `"changed"` | `changed` judges only findings in files the push carries; `all` judges every finding in the results, which will block on pre-existing ones. |
| `sastEditedSeverityActions` | `{}` | Severity → `"block"` or `"ask"`, applied **only** to findings in files this session edited. Holds new work to a higher standard than the existing backlog. **Managed: floor**, as above. |
| `sastCommand` | unset | Argv list that regenerates `sastSarifPath`, run in the background when results go stale. Not a shell string — nothing is word-split. Unset means results are never refreshed for you. |
| `secretScanIncremental` | `true` | Scan commits for secrets in the background and gate pushes on that, instead of requiring the agent to run `gitleaks` itself. `false` opts out and returns the gate to transcript evidence — a `gitleaks` run the agent made in this session — which accepts a plausible command plus output text saying no leaks were found, where the daemon's scan reads the commits the push would actually send. |
| `syncWaitMs` | `150` | Bounded wait for the transcript to drain before a check. **Managed: advisory** — the managed value replaces the local one, but no code path reads it, so pinning it changes nothing. |
| `daemonIdleMin` | unset | Exit after this many minutes with no sessions. |

### Connection and deployment settings

The table above is what the gate *does*; these say where it runs and who it
talks to. They are listed because a setting nobody knows about is a setting
nobody can check — the same reason the behaviour table exists.

| Key | Type | What it does |
|---|---|---|
| `mode` | `"local" \| "remote"` | Run the engine locally or talk to a remote one. **Managed: locked by presence** — while a managed file applies this is read from it or from the built-in default only, whether or not the file names it. |
| `endpoint` | string | Address of the policy engine. **Managed: locked by presence**, as `mode`. |
| `transport` | string | Hot-path transport; see **Hot-path transport** below for the latency / fail-mode trade. **Managed: advisory** — the managed value replaces the local one, but nothing in the daemon reads it: the hot path is whatever `.claude/settings.json` wires up, and this key only changes what `sasy-watch print-hook` prints. |
| `daemonPort` | number | Port the local daemon listens on. **Managed: plain override, and not a protection** — it is also the unauthenticated loopback port the hooks send checks to, chosen in the hook's own environment by `SASY_WATCH_PORT`, so a same-user process can answer instead and both allow every call and fake `/healthz`. |
| `apiKey` | string | Credential for a remote engine. |
| `entity` | string | Principal the calls are attributed to. |
| `roles` | string[] | Roles that principal holds, which role-keyed rules read. **Managed: locked by presence** — a role is a claim the client asserts about itself on every call, not a credential the engine issues, so a local list can only unlock role-keyed rules that would otherwise not match. The empty default is the strictest value; an organisation that keys rules on roles names them in the managed file. `apiKey` and `entity` stay local for the opposite reason: they are how the daemon authenticates to a managed endpoint at all, so dropping them would break that connection rather than tighten anything. |
| `policyProfile` | string | Which baked profile to bind (restricted appliance builds). **Managed: one lock with `policyPath`, and locked by presence** — a managed value for either key drops a local value of the other (`SASY_POLICY_FILE` included), because the daemon resolves `policyPath` first and locking only the profile would leave that path free to choose the policy. It still locks the profile *name* only — the name resolves to `$SASY_HOME/policies/<name>.dl`, a file the developer owns and can rewrite (except on the restricted appliance, whose engine refuses a substituted policy). |
| `policyPath` | string | Explicit `.dl` to pin instead of a profile; `SASY_POLICY_FILE` sets it. **Managed: one lock with `policyProfile`, and locked by presence**, as above — a managed file that names neither policy key still drops a local `policyPath` and `SASY_POLICY_FILE`. |
| `insecure` | boolean | Use plaintext gRPC to a remote engine. Development only; local managed children always use mutual TLS. **Managed: final, and locked by presence** (one-directional: only the looser local `true` is dropped, a local `false` still counts) — a managed `false` ignores a local `true` and `SASY_INSECURE=1`; a managed `true` still yields to a local `false`. A managed file that pins a remote engine without naming `insecure` refuses plaintext outright — a managed non-loopback `endpoint` is enough, since `mode` is a lower-tier key the developer sets (`sasy-watch setup` writes `mode: "local"`). A managed loopback endpoint uses launch-generated mutual TLS in local mode. Pin `mode: "remote"` alongside the endpoint anyway, because local mode refuses a non-loopback endpoint. |
| `serve` | object | Settings for the engine child process the daemon spawns — `binary`, `dataDir`, `evaluator`. **Managed: locked by presence** — while a managed file applies, a local `serve` is dropped whole, so an organisation whose developers run a local engine must name `serve` in the managed file (or pin `mode: "remote"` + `endpoint`); otherwise no engine child starts. Local launches require mutual TLS with a fresh private CA; an existing listener is never adopted. Without a configured binary, checks are denied. An occupied port or an older binary without `guard-tls` fails startup; stop the intended old instance explicitly or configure a remote engine. `evaluator: "stub"` from a **lower** source is refused outright, with or without a managed file: it is the shipped backend that allows everything, so the daemon would stay healthy and every check would pass. A managed file may still select it. |
| `enrich` | boolean | Force daemon-side metadata enrichment on or off, overriding the per-profile default. **Managed: locked by presence** (one-directional: only the local `false` is dropped) — a local `enrich: false` silences the supply-chain and public-push facts, so those rules stop matching while every lock still reports as in force. A local `enrich: true` asks for *more* facts than the default, which can only make rules match, so it stands. The lock reaches the daemon: `sasy-watch check`, the command-line enforcement path, gathers no facts at all unless `SASY_ENRICH=1` in its own environment. |

Rule groups: `data_loss`, `secret_scan`, `exfil`, `toxic_flow`, `reverse_shell`,
`config_persistence`, `guard_config`, `agent_redirect`, `curl_sh`,
`hidden_unicode`, `public_push`, `review_gate`, `supply_chain`, `dep_scan`,
`sast`.

### Choosing a static analyser

Measured on this repository, first-party code only:

| Tool | Findings | Notes |
|---|---|---|
| Bandit | 1,453 | 1,328 are `assert` in tests. Of the 7 at HIGH/MEDIUM, all 7 were false positives — a string literal `"0.0.0.0"` in code that rewrites it to loopback, `urlopen` against a hardcoded loopback test daemon, and `"/tmp/x"` inside an assertion string. |
| Semgrep (`p/python`, `p/security-audit`, `p/typescript`, `p/command-injection`) | 0 | 407 files, 343 rules. Verified non-vacuous: on a deliberately vulnerable fixture the same rules found 5, including taint-tracked SQL injection. |

Two things follow. `sastScope: "changed"` is the default because a repository
accumulates findings nobody is touching. And severity mapping matters more than
tool choice: Bandit produces no `security-severity` scores, so everything it
reports lands in `high` or below via SARIF `level`, and its `high` band on this
repo was entirely noise.

Bandit needs the `bandit-sarif-formatter` package for `-f sarif`; it is not
built in.

Licensing is worth checking before choosing. The CodeQL CLI may not be used on a
codebase that is not open source without a paid GitHub Advanced Security licence.
The Semgrep registry rules are under the Semgrep Rules License, which permits use
"for your own internal business purposes" but not distribution or offering them
as a service — fine for scanning your own code, and the reason this guard reads
results rather than shipping any engine or ruleset.

### Managed settings (`/etc/sasy/managed.json`)

An organisation can pin any of the settings above in a file the developer's
`~/.sasy/config.json` and `SASY_*` variables do not override:
`/Library/Application Support/SASY/managed.json` (macOS), `/etc/sasy/managed.json`
(Linux and WSL), `C:\ProgramData\SASY\managed.json` (Windows) — the same shape
as `config.json`, and the same locations pattern Claude Code uses for its own
managed settings, so one MDM profile deploys both. The file must pass all four
admin-source checks or it is ignored and reported: not a symbolic link (it is
opened with `O_NOFOLLOW`, so a link cannot borrow another root-owned file's
ownership), owned by root, not group- or other-writable, and sitting in a
directory that is itself root-owned and not group- or world-writable. The first
three are decided on the open file handle — one `open`, then `fstat` and read
*that* handle, so the bytes checked are the bytes used. The directory check is
different and weaker: an `lstat` of the directory **by path**, after the file has
been read (`lstat`, so a symlinked directory is judged on the link, whose own
mode is `0777` and therefore fails). It reports the directory as it is at that
moment, not as it was when the file was opened. Only the file's own directory is
checked, not the whole path above it. A second name for
the file's bytes — a hard link — is **reported** (`hardLinks` in `/healthz`, a
line in `status`), never a refusal: a link count belongs to the bytes rather than
to the path, so any user who can read the file can raise it from a directory of
their own, and refusing on it would be a one-line switch for turning the whole
tier off. It protects nothing either, since a link *at* the managed path
needs write access to that root-owned directory. Compare the file's contents with
the payload you deployed. **On Windows it is never applied**: no ACL check is implemented there, and applying an unverified
file at the highest precedence would let any local user plant settings that
outrank the developer's own — so it is refused and reported instead.

Keys marked **Managed:** in the tables above lock in the direction shown; every
other key is simply replaced, and the matching `SASY_*` variable is ignored. A
stricter local value still counts only where the key has a direction to be strict
in — `failMode`, `insecure`, `enrich`, `cooldownDays`, the review thresholds;
everywhere
else the managed value replaces the local one in both directions. Every lock is a
lock on a key the managed file actually **sets**, with two exceptions below (the
presence class, and the scan gate, which is governed as one group) — a
key outside those and outside the file is not locked, and the local value
applies (`secretScanIncremental`, `entity`, `apiKey`, `daemonPort`,
`daemonIdleMin`).

**One class is different: locked by presence.** `serve`, `mode`, `endpoint`,
`insecure`, `failMode`, `enrich`, `policyProfile`, `policyPath`, `roles`,
`ruleOff`, `ruleOn`, `trustedDomains`, `cooldownDays`, `reviewDiffLines`,
`reviewFixDiffLines` and `reviewEditThreshold` are read from the managed
file or the built-in default **only** — never from `~/.sasy/config.json` and never
from a `SASY_*` variable — for as long as a managed file applies, whether or not
the file names them. Two reasons. Seven of them (`serve`, `mode`, `endpoint`,
`insecure`, `enrich`, `policyProfile`, `policyPath`) decide which engine answers a
check and whether the daemon gathers facts at all: a local value there does not
soften one rule, it removes the meaning of every rule at once while the engine
keeps answering, so `failMode: "closed"` is satisfied and nothing is denied. The
other nine have a built-in default that is already the strictest value they can
take — `closed` for `failMode` (a check that cannot be answered is denied), `[]`
for the lists (every group runs, nothing is allowlisted, no role is claimed), and
the in-policy numbers for the thresholds. Without the class, a local
`ruleOn: ["hidden_unicode"]`
switches off the very group a managed lock governs while every surface prints the
lock, and `SASY_FAIL_OPEN=true` makes the daemon answer every failed check with an
allow whenever the managed file simply does not mention `failMode` (on a machine
where no engine child starts, that is every check). For `failMode`, `insecure`,
`enrich` and the
numeric four the drop is one-directional: only a value looser than the policy
default is dropped, so a developer who fails closed, keeps TLS on, gathers more
facts, reviews sooner or waits
longer keeps their setting. The `failMode` lock reaches
the **daemon**; the hooks read `SASY_FAIL_OPEN` from their own environment when
the daemon is unreachable and do not consult the managed file. `/healthz` and `sasy-watch status` also report
which rule groups actually run, next to the locked keys, and whether the scan
gate is governed (`sastGroupLocked`). Each displaced local
value is named in the startup log, and whose scan any floor is measured on
(`sastScanSource`: `"managed"`, `"local"` or `"none"`). Two consequences: name `serve`
in the managed file if your developers run a local engine (otherwise no engine
child starts and local checks are denied), and note that `apiKey`,
`entity`, `sastSarifPath`, `sastCommand`, `sastScope` and `secretScanIncremental`
are deliberately **not** in the class — `sastSarifPath` and `sastCommand` are
off by default, so reading them from the default only would remove a gate the
developer opted into; `sastScope` (default `"changed"`) would narrow a scan the
organisation has not taken over; and `secretScanIncremental` is **on by
default**, so presence-locking it would overturn nothing but a developer's
explicit `false`, and that opt-out stays theirs unless you name the key. Pin any
of them in the managed file if you rely on them.

**The scan gate is governed as one group.** `sastSarifPath`, `sastCommand` and
`sastScope` decide, in that order, which file the findings are read from, who
writes that file, and how many of the findings a push is judged on — one gate,
three keys. So naming **`sastSarifPath` or `sastCommand`** in the managed file,
with a usable value, makes all three read from the managed file or the built-in
default only, the same way the presence class works, and each dropped local value
is named in the startup log. Without that, a managed SARIF path sat next to a
local `sastCommand`: the daemon takes ownership of the results store and
regenerates it with the developer's command, so `["/bin/true"]` leaves a valid,
empty results file that satisfies every band while `/healthz` reports the floor as
in force and `sast` as running. A managed file that names neither leaves all three
local, which is the single-machine case — a scan is off until one is configured,
and governing these uninvited would remove a gate rather than lock one. For the
same reason a managed sast key whose value is refused (`sastSarifPath: null`) does not
govern the group either.

**`sastScope` is in that group but does not trigger it.** It only narrows or
widens what a push is judged on, and configures no scan, so a managed file whose
only sast key is `sastScope` is an ordinary fixed lock: the managed scope applies
over the local one and the developer's scan keeps running. (Triggering on it
dropped that scan — the tightening key switching the gate off.)

**A severity floor alone does not govern the scan — and it may be measured on
nothing.** `sastSeverityActions` and `sastEditedSeverityActions` say what a band
*does*; they do not configure a scan, so a managed file whose only sast keys are
those two floors whatever scan the local configuration runs, and floors *nothing*
when the local configuration runs none. (Treating a floor as the organisation
taking the gate over was worse: it dropped the local `sastSarifPath`, so a payload
asking for a floor switched the whole gate off.) Both surfaces therefore report
`sastGroupLocked` — whether the managed file owns the three scan-config keys —
and, separately, who supplies each half of the scan: `sastScanSource` for the
`sastSarifPath` the gate READS and `sastScanWriter` for the `sastCommand` that
WRITES those results, each `"managed"`, `"local"` or `"none"`. `sastSarifPath`
decides whether anything is scanned at all — the gate returns before it reads a
finding when no path is set — which is why the two are reported apart.
`status` says it in words: *scan gate: governed by the managed file*, or *sast
floor: in force over a LOCALLY configured scan (a scan read from sastSarifPath
from ~/.sasy/config.json, written by …) — pin sastSarifPath in the managed file to
own the scan*, or *sast floor: in force over NO scan: nothing is scanned until a
scan is configured* — the clause naming the two halves reads *nothing is scanned:
no sastSarifPath is set*. A managed `sastCommand` with no `sastSarifPath` anywhere gets
its own line — *the managed sastCommand writes results the gate never reads, so
pin sastSarifPath in the managed file too* — because that payload looks complete
and gates nothing.

**If the merge itself fails, the locked keys do not fall back to
`config.json`.** A managed file that fails an admin check (not root-owned, a
symlink, malformed) is ignored whole and the local settings stand — that is the
statement "this is not an administrator's file". A file that *passes* every check
and then hits an internal error in our own merge is a different statement, so it
gets a different outcome, **safe mode**: the file was accepted, so its own values
still apply. Safe mode is a **separate, total function** — the code that just
failed cannot be the code that decides what applies instead — but it is **not a
separate rule**: it reads every managed value with the same readers the ordinary
merge uses and combines it with the local value through the same lock helpers.
Class by class: **settings keys only** (a key that is not a setting is not
applied, and is reported as `unknownKeys`); the **presence class** takes the
file's usable value and otherwise the **built-in default**, never
`~/.sasy/config.json`, with a stricter local value still standing and a
directional key combined exactly as its lock says (the larger `cooldownDays`, the
smaller review threshold, the union for an opt-in `ruleOn`); the **scan group**
`sastSarifPath`, `sastCommand` and `sastScope` follows the ordinary merge's rule —
governed by the file whenever it names `sastSarifPath` or `sastCommand` with a
usable value, local otherwise — so a local `["/bin/true"]` cannot sit under a
managed SARIF path here either; the **severity tables** take the file's usable
table floored over the local one, and otherwise the local table; and **every other
key** takes the file's usable value and otherwise the local one, so the one gate
key outside the scan group (`secretScanIncremental`, on unless something set it
to `false`) keeps whatever the file or the developer chose for it — an error in
our own code neither switches the scan off nor overrides an opt-out. "Usable" is
the ordinary merge's own
reader: `"30"` is 30, `"true"` is `true`, `sastCommand: []` is refused (an empty
argument list turns the daemon's ownership of the results store off), and a
severity table must name a band the policy knows. **Not claimed: that safe mode is
at least as strict as the ordinary merge for every key** — that claim was made in
an earlier round and was false for six pairs, the `/bin/true` one included; what
is claimed is the rule above, and a test matrix compares the two merges pair by
pair. The rules that sit **above** the merge still apply, because the file was
accepted: a managed non-loopback `endpoint` with no managed `insecure` refuses
plaintext here exactly as it does in the ordinary merge, so this state does not
send the organisation's API key to `engine.corp:443` in the clear. A managed loopback endpoint uses launch-generated mutual TLS in local mode, safe mode included. Otherwise one value in a developer's own settings that the merge could not
read would be a switch for the whole tier. `/healthz` reports `safeMode: true`
next to `applied: false` and **two** key lists, because they are two facts:
`safeModeContributed` (the keys whose value the readers could use — what the
organisation contributed) and `safeModeApplied` (those where the file's own value
is what applies, unchanged). They differ wherever a lock combines the tiers: a
managed `cooldownDays: 30` under a local `90` applies as 90, a managed floor
keeps a local band beneath it, a managed `failMode: "open"` yields to a local
`"closed"`, an opt-in `ruleOn` is the union of both lists. One list, reported as
"the keys safe mode applied", named the organisation as the source of all of
those — the wrong tier on the line an administrator acts on. Both are values,
never locks. `status` and the startup log say *managed file present but not
applied (internal error: …)* followed by the rule in these words — *safe mode
applies the managed file's usable values with the same readers and lock rules as
the ordinary merge, and is computed by a separate, total function: settings keys
only; for the presence class the file's usable value, otherwise the built-in
default and never config.json (a stricter local value still stands, and a key
with a direction is combined as its lock says); for the scan group
sastSarifPath, sastCommand, sastScope the same rule as the ordinary merge —
governed by the file whenever it names sastSarifPath or sastCommand with a usable
value, and left local otherwise; for the severity tables the file's usable table
floored over the local one, and otherwise the local one; and for every other key
the file's usable value, otherwise the local one* — and then both key lists. No
known input reaches this state — it exists for a bug in our own merge.
A key that is not a setting at all (an MDM typo such as `failmode`) is reported as
locking nothing rather than listed among the keys in force, and so is a key whose
**value** is not the shape that key needs. Every key states one. A scalar spelled
as text is read where the spelling is unambiguous — `"30"` is the number 30,
`"true"` is `true` — and everything else is refused outright (reported as
`invalidKeys`): `"soon"` for a number, `"yes"` for a boolean, a list where a band
table belongs, a string where a list belongs, an **empty** severity table (`{}` —
a floor over nothing, reported as locking nothing instead of as a floor in force;
an empty local table is dropped with a note for the same reason), and `null`
anywhere. For a key with
a direction, writing a wrong-typed value through would invert the very lock it was
meant to be; for the rest — `sastSarifPath: null`, `sastCommand: "uv run sasty
scan"` as a shell string instead of a list, `sastScope: "everything"`, `enrich: 0`
— it would turn off the gate that key belongs to while `status` still printed the
lock. A refused value leaves the local one standing, except for a key locked by
presence, where the built-in default applies. Each displaced local
value is named in the daemon's startup log — quoted and cut to 120 characters,
because these lines are assembled from files and an unquoted value carrying a
newline wrote a second line at column 0 in the daemon's own voice (`{"entity":
"me\n[sasy-watch] managed settings applied from /etc/sasy/managed.json"}`); the
same helper covers band names, unrecognised key names, `status` and the
`sasy-watch setup` report. The 120 characters are counted on the **quoted** text
— what is actually printed — and the value is cut until its quoted form fits,
with the ellipsis outside the closing quote; counted on the raw value instead, a
value of 120 control characters printed as 723. The cut never ends inside an
escape, and never on half a surrogate pair — an emoji is two UTF-16 units with no
backslash to mark them, and half of one is text that is not well-formed UTF-16.
A **list** of names stops at
twenty and says how many more there are, and so does a note written once per
entry of a list in `~/.sasy/config.json`, so a `ruleOff` naming five hundred
groups is twenty lines and a count rather than five hundred lines at every
daemon start — the local `ruleOn` groups a managed opt-in list adopts included.
And with no secret in it: for a key whose
name contains `key`, `token`, `secret`, `password` or `credential` the line names
the key and where the ignored value came from and prints neither value, because
that log is an append-only file (`~/.sasy/logs/daemon.log`). `/healthz` plus
`sasy-watch status` show which file is in force — as a report on an intact install, not as
proof of one; both are served over unauthenticated loopback. Because they are,
`status` treats the whole answer as text from outside: it checks the **shape**
first, against a table with one entry per field naming that field's **exact
type**, in six kinds — a text (a string), a count (a whole number, zero or more
— a count of things, so not `-1`, not `1.5`), a yes/no
flag (a boolean, not the string `"true"`), one of a fixed set of words
(`sastScanSource` and `sastScanWriter` are each `managed`, `local` or `none`), a
list of texts, and the one nested
`ruleGroups` object, which holds two lists (`running` and `off`) and an `optIn`
flag — and prints one line naming the field when the answer is not that
(`managed: the daemon's health answer is malformed (keys)`) — a `keys` that was
a string used to print one invented lock line per character, and a missing one
threw — and then every value it prints is quoted, the file path and the refusal
reason among them, so a newline in the answer cannot open a second `status` line
in sasy-watch's own voice. That exactness is what settles the same question for
the five fields `status` reads to pick *which* line to print rather than putting
them in one (`applied`, `safeMode`, `sastGroupLocked` and the two scan-tier
words): they hold a value from a **closed set** the check has already admitted,
and no member of those sets contains a newline, so such a value **cannot carry a
newline** into any line the report builds, now or later. The full, uncut answer
is the JSON `status` prints
above those lines — up to the bound it is read under. `status`
reads at most **256 KiB** (256 x 1024 bytes) of an answer it accepts, nested
no deeper than **16 levels** (the daemon's own answer is a few kilobytes and four
levels deep), and a bigger or deeper one is not the daemon's and is not shown at
all. A **compressed** answer is not the daemon's either — its `/healthz`
compresses nothing — so one carrying a `content-encoding` header is refused where
that header is, with its body never read, and `status` asks for no compression
and decodes none that arrives anyway: 256 KiB is therefore also the most it ever
*decodes*. Before that rule the cap counted decoded bytes, after the machine had
paid for them — 605 bytes of compressed answer inflated to 400 MB and 1.04 GB of
memory. An answer whose `content-length` **declares** more than the cap is
refused at its headers too, while the count taken during the read is kept
regardless, a declared length being the port's own word for it. What `status`
prints is bounded with what it reads, and the number is **at most 9,175,040
bytes**, about **9.2 MB**: the answer is printed as indented JSON, which gives
every value *and every bracket* a line of its own, no line is longer than a line
break, at most 32 spaces of indentation, what is on it and a comma, and each of
those lines cost at least one byte to send — 35 printed for one sent as the
line-by-line bound, a figure no answer actually reaches. Two kinds of value print
longer than they were sent and the bound survives both (a number such as `1e20`
prints twenty-one characters for four sent; a string carrying an invalid UTF-8
byte prints a three-byte replacement for each): for every value, 34 plus its
printed length is at most 35 times its sent length. The true worst case over
every answer both caps admit is **26.875 printed bytes per sent byte**, approached
by a chain of three one-element lists (a limit no finite answer reaches), so
nothing can print more than **7,045,120 bytes**;
9,175,040 stays as the stated bound because it is the one a reader can check in a
line. The widest answer the test builds measures **7,027,491
bytes** through the
command: 256 KiB of `[[[0]]],`, three nested one-element lists around a
one-character value at the deepest level the depth rule allows, printing 215
bytes for every 8 sent. A *closing* bracket is what makes that dearer than a
plain list of values — it prints a whole indented line for one byte and needs no
comma after it. A 20 MB answer used
to be echoed in full, and a 200 KB one nested 100,000 deep threw `Maximum call
stack size exceeded` out of the command, leaving nothing
printed. Nobody has to answer, either: the command waits **5 seconds**
for the connection, the headers and the body together, and nothing listening, a
refused connection and a body that never ends all print `the daemon gave no
answer on this port within 5 seconds — it may be stopped, or something else may
be holding the port without answering; start it with sasy-watch ensure and ask
again ("TimeoutError")`, the short reason quoted after the sentence — before that
deadline, a process that sent
headers and went quiet could hold the command open indefinitely. An answer that
is **not 2xx** is not the daemon's at all (its `/healthz` answers 200
unconditionally), so its body is not read and nothing of it is shown, and **a
redirect is not followed**: a `301` naming another URL is refused where it
stands, rather than fetched and rendered as this machine's report. An answer
that is not JSON at all — an HTML error page from whatever else is listening —
reads as the same fact and prints the same `the daemon did not report managed
settings … restart the daemon` line; there the body is not echoed, since unparsed
text from the port could open that line itself — and it is not echoed for any of
the other refused answers either, so nothing `status` refuses reaches the report.
`sasy-watch status` exits zero
only when it printed a well-shaped report: no answer, a non-2xx answer, a
redirect, a compressed answer, one declaring more bytes than the cap, an answer
over the size or depth bound, a body
that is not JSON and a body that is JSON but carries no well-shaped `managed`
block all exit non-zero.

Full reference: "Managed settings for a team" in the enforcement guide
(`docs-site/src/content/docs/claude-code-sasy-guard/enforcement.mdx`, published as
*Enforcing Policy on Claude Code*).

### Who these settings belong to

Anyone who can edit `~/.sasy/config.json` can set `ruleOff`, or `failMode:
"open"`, or export `SASY_FAIL_OPEN=true`, and the checks stop applying. On a
single machine that is the correct design — it is the developer's own guard. All
three are closed by the managed file below, and closed by its *presence* rather
than by remembering to name them: while one applies, `ruleOff`, `ruleOn` and
`failMode` are read from it or from the built-in default only.

The managed file above answers part of "is my whole team covered, including
people who would rather not be", but only part. It is **default application plus
partial tamper evidence, not a security boundary** — for an administrator and for
an ordinary developer alike. Nothing in the chain needs elevated rights to
change: a managed `policyProfile` locks the profile *name*, and that name resolves
to `$SASY_HOME/policies/<name>.dl`, a file the developer owns (only the restricted
appliance, whose engine refuses a substituted policy, closes this); a lock reaches
a `SASY_*` variable only when that variable sets a setting, and the ones that
decide the most do not — `SASY_HOME`, `SASY_WATCH_PORT` and `SASY_WATCH_BIN`
(`SASY_FAIL_OPEN` does set one, `failMode`, and is dropped by the presence class
above — but only for the daemon: the hooks read it from their own environment when
the daemon is unreachable), and equally `SASY_OSV_BATCH_URL`, `SASY_OSV_QUERY_URL`,
`SASY_NPM_REGISTRY`, `SASY_PYPI_JSON` and `SASY_GITHUB_API`, which point the
daemon's advisory, registry and repository-visibility lookups at a loopback stub
(loopback-only and logged loudly, but a stub that answers "no advisories" or
`{"private": true}` still empties the supply-chain and public-push rules), and
`SASY_ENRICH_DEADLINE_MS`, which at `1` makes every resolver miss the budget so a
resolved hard deny degrades to an @ask, and `SASY_ENRICH`, which `sasy-watch
check` — the command-line enforcement path — reads from its own environment to
decide whether it gathers any facts at all, whatever a managed `enrich: true`
says (the daemon passes its own value and is not affected). The `enrich` presence
lock decides whether the **daemon** gathers those facts, not where they come from,
how long that may take, or what the command-line path does, and
the daemon keeps the environment of the shell that first spawned it; the daemon binary, the hook binary and the hook wiring in
`.claude/settings.json` are user-owned; and deleting the managed file leaves no
trace afterwards, though the deletion itself asks: the managed directory is one of
the paths the `guard_config` group protects, so an agent's `rm`, `mv`, `chmod` or
`ln` naming it prompts first (a fleet tool should still compare the file's
contents, not just check that the path exists — "present" is satisfied by an empty
file or a link). That prompt is matched on the path as text, in the spellings a
shell accepts for it: the plain path, the quoted path
(`"/Library/Application Support/SASY"`) and the backslash-escaped path
(`/Library/Application\ Support/SASY`) are all recognised; a glob
(`/Library/Application*/SASY`), a variable, or a relative path from inside the
directory is not. Inside
`config.json` itself, the keys that could substitute the engine or silence its
facts are covered by the presence class above, but a local `sastSarifPath`,
`sastCommand`, `sastScope`, `secretScanIncremental`, `daemonPort`,
`daemonIdleMin` or `transport`
still applies — the first three unless the managed file names `sastSarifPath` or
`sastCommand`, which is what hands the scan gate to the organisation; a managed
severity floor does **not**, and neither does a managed `sastScope` on its own, so
a floor pinned alone is measured on whatever scan `~/.sasy/config.json`
configures, or on nothing at all (`status` and `/healthz` say which, as
`sastScanSource` and `sastScanWriter`) —
and `daemonIdleMin` is worth naming, because it decides how long a
daemon that started *before* the managed file was installed keeps serving its
pre-managed settings: `sasy-watch ensure` does not restart a running daemon, so
until that daemon idles out (or is killed) the file is not in force on that
machine. It becomes a real boundary only once the daemon runs under a separate OS
account that also owns the policy and the hook wiring — which is not built yet.

## Hot-path transport

Three transports trade latency against fail-open vs fail-closed. Measured
per-call cost (registered session, real check):

| transport | per-call | fails | how |
|---|---|---|---|
| **script** | ~52 ms | **closed** | plugin `scripts/pretooluse.sh` → curl. Zero build, works everywhere. |
| **native** | **~2 ms** | **closed** | the `sasy-hook` binary (raw HTTP POST, exit 2 on down). 23× faster than curl, still fail-closed. |
| **http** | ~0.2 ms | **open** | CC POSTs the daemon directly, no subprocess. Fastest, but a down daemon lets tools through. |

**Default behavior:** the plugin's `PreToolUse` script auto-`exec`s the native
`sasy-hook` binary when it's installed (`~/.sasy/bin/sasy-hook`, placed by
`sasy-watch setup`), falling back to curl otherwise — so you get fail-closed
enforcement at ~30 ms with no configuration (the residual cost is the shell
spawn). Set `SASY_FORCE_SCRIPT=1` to force curl.

For the direct native path, generate a command hook:

```sh
sasy-watch print-hook --transport native
```

Keep the plugin's `SessionStart`, `SessionEnd`, and `PostToolUse` hooks. Every
request reads the daemon's per-launch mode-0600 authentication header file under
`SASY_HOME`. Approval questions are supplied through PreToolUse `updatedInput`
and completed only by the authenticated, matching session/tool call.

`--transport http` is refused: Claude's direct HTTP hooks do not block when the
daemon is unreachable. Existing HTTP configurations must switch to command
hooks. See the [approval authentication documentation](https://guard.sasy.ai/claude-code-sasy-guard/enforcement/#approval-hook-authentication)
for retries, expiry, and the same-user limitation.
