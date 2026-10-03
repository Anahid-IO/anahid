# Design

## What this tool answers

For every tool call a coding agent made on this machine, from files already on disk:

1. **Who refused it, stated correctly.** A person, a settings rule, a hook, the agent's own built-in checks, an automatic classifier or reviewer, or the sandbox. The vendor's own label is kept next to ours, and a mismatch is reported, not hidden.
2. **Who answers for it.** Declarations name the person each agent answers to in each project. An act in a directory no declaration covers is `undeclared`; an act whose declared agent reaches no person is `unaccountable`.
3. **What the record cannot see.** Deleted transcripts, hooks that timed out, refusals classified from text alone, and formats we have not tested.

It installs nothing, runs no other program, sends nothing and writes nothing. The simulation in `sim/` is separate: it runs the real agents and moves the transcripts they leave.

## Why these three

The transcripts already hold the evidence, but the labels on it are often wrong. On one machine from 2026-08-31 to 2026-10-03, Claude Code labelled 75 refusals `user-rejected`. 6 were a person saying no, 62 were approval requests nobody answered, and 7 were built-in checks. Hook blocks and settings rules share one label. Codex keeps its automatic reviewer's verdicts but not a person's. A record that says "the user refused" when no user was asked is not evidence.

Cost reports, hash chains and policy gates are well covered by other tools. This one stays out of those areas.

## Shape

```
readers/*.mjs   file on disk  -> acts and reviews  (one reader per agent; each also names its own blind spots)
classify.mjs    refusal text  -> layer             (a table of signatures, tested by vectors)
scan.mjs        acts          -> counts, examples, shared blind spots
repo.mjs        directory     -> main checkout of its git repository (read from .git on disk)
report.mjs      counts        -> text
bin/anahid.mjs  arguments     -> exit code
```

`declare.mjs` reads the declarations and names, for each act's engine and project, the person who answers for it.

## Declaration

Declarations are `anahid.declaration/3` files, one per project, the declaration format the Anahid product stores. A file written for this tool loads in the product unchanged, and a product file with source paths works here. They are read from `$ANAHID_HOME/declarations/` (by default `~/.anahid/declarations/`) or `--declaration <file or directory>`, which may repeat. The folder is never created.

Only three parts are read, and nothing else is copied into a report:

- `humans`: each person's `name` and `role`.
- `agents`: each agent's `owner` (a key of `humans`) and `parent` (a key of `agents`).
- `sources` of kind `claude-code-hooks` or `codex-hooks`: the `agent` whose acts they are, and `path`, where those acts happen.

Rules:

- An act of Claude Code resolves through a `claude-code-hooks` source, an act of Codex through a `codex-hooks` source, so one directory can have different owners for each engine.
- The longest source path that contains the act's working directory wins. If none does, the directory's git repository (its main checkout, shared by every worktree) is tried, so declaring a checkout covers its worktrees while they exist. A directory that is gone cannot be placed in a repository; declare its parent path. `~` is the home directory; a path that exists is also matched as the system resolves it.
- An agent answers to its `owner`, else to its `parent`'s, the same walk the product does.
- No covering declaration: `undeclared`. A covering declaration whose agent reaches no person: `unaccountable`. The product uses both words the same way.
- Who decided an act (its layer) and who answers for it are separate questions. A person can answer for an act that a rule, a hook or a reviewer decided.
- A file that is not `/3`, names an unknown owner, parent or agent, has a relative path, binds no path, or declares a person differently from another file is refused with exit 2.

- Readers stream line by line and never hold a whole transcript in memory.
- Every finding carries its source as `file:line`.
- The signature table is data, not code, so a new agent version is a table change plus a vector.
- The JSON output has a versioned schema, `spec/refusals.schema.json`, with `$id` `https://anahid.io/schemas/refusals/1.json`. Version 1 grows only by adding fields and values; consumers ignore what they do not know. A test fails if a report field is missing from it or it names a field reports do not carry.
- Exit codes: 0 report printed, 1 a `--fail-on` layer refused a call or nothing was scanned, 2 bad arguments or declaration, 3 the scan failed.
- `test/fixtures/real/` holds real records with every command, path and message scrubbed. They pin the field names the readers rely on.
- Zero runtime dependencies. Node 22 or newer.

## Refusal layers

| Layer | Meaning | Claude Code evidence | Codex evidence |
|---|---|---|---|
| `person` | A person answered no | human rejection text, `toolUseResult: "User rejected tool use"` | not placed: a person answers only in the interactive TUI, which cannot be simulated headless, so it shows as `unknown` |
| `unanswered` | Approval was requested and the call was denied with no answer on record | `user-rejected` label on an approval-request text | |
| `rule` | A settings allow or deny rule | `permission-rule`, "Permission to use ... has been denied" | |
| `hook` | A PreToolUse hook blocked it | text prefix `PreToolUse:<Tool> hook error:` | |
| `program` | A program answered the approval prompt (prompt tool or SDK host), placed by inference | `permission-rule` with free text | |
| `classifier` | An automatic classifier or reviewer blocked it, or could not answer in time | `automode-blocked`, `automode-unavailable` | "rejected due to unacceptable risk", review deadline missed |
| `sandbox` | The sandbox refused it | | `patch rejected: ... rejected by user approval settings` (wording blames the user); a sandboxed shell command fails with "Operation not permitted" and is counted apart |
| `builtin` | A built-in safety check blocked it outright | "was blocked. For security, ...", `Blocked: ...` | |
| `interrupted` | The session was interrupted | `interrupted` | |
| `unknown` | A denial we cannot place | anything else carrying a denial label | any other `Rejected(...)` |

Plain tool failures (exit codes, missing files, validation errors) are not refusals and are counted apart.

## Limits we state in every report

- The transcript format is undocumented and changes between versions. The report names the versions seen and the versions tested.
- Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default). Nothing before that is visible.
- A timed-out PreToolUse hook lets the call run unchecked. Those are counted.
- Codex does not save a person's approval decisions. The report counts the turns that had a person as the approver.
- Codex sandbox errors look like ordinary "Operation not permitted" failures. They are counted as failures and reported as possible sandbox refusals.

## Simulation

`npm run sim` drives the real `claude` and `codex` CLIs into each kind of refusal, then runs `anahid` on the transcripts they leave. Scenarios are in `sim/scenarios.mjs`; each names what it expects, and a miss is a finding about the agent as much as about this tool. Every command is harmless if a layer allows it. A run's transcripts are moved out of `~/.claude` and `~/.codex` so they do not pollute the user's own reports. Results land in `sim/results/`. It costs model tokens and is not part of `npm test`.

Found by simulation on Claude Code 2.1.283 to 2.1.288 and Codex 0.155.1:
- Headless Claude Code with nobody to answer (`--permission-prompts none`) says "this session has no approval surface" and labels it `permission-rule`.
- A background subagent's unanswerable prompt reads "Permission to use Bash has been denied.", labelled `permission-rule`, word for word what a deny rule on the whole tool produces.
- A patch refused by Codex's read-only sandbox reads "rejected by user approval settings". The sandbox refused it; the wording names the user.
- A program answering the prompt (`--permission-prompt-tool`) is labelled `permission-rule`, and the record holds only the program's own message.
- `claude -p` exits 0 when a tool call was refused. On 2.1.288 all 8 simulated refusals ended with exit 0. `--fail-on` is the exit code a script can check.
- A model that declines before calling a tool leaves nothing to count. The model often declines before auto mode's classifier sees anything; on 2.1.288 the classifier was reached and refused a force-push as `[Git Destructive]`, labelled `automode-blocked`.

## Codex

Rollouts live in `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (and `archived_sessions/`). Tested on 0.149.0 to 0.155.1.

- An act is an `item_completed` event whose item is a tool (`CommandExecution`, `FileChange`, `McpToolCall`, `Extension`, `ImageView`, `CollabAgentToolCall`). Its `status` is `completed`, `failed` or `declined`.
- A command the approval layer refuses never starts, so it has no item. The refusal survives only in the exec script's error text: `exec_command failed for \`cmd\`: CreateProcess { message: "Rejected(\"...\")" }`. The message is Rust Debug output, escaped twice.
- `turn_context` records the policy in force each turn: `approval_policy`, `approvals_reviewer` (`user` or `auto_review`) and `sandbox_policy`.
- The automatic reviewer ("guardian") writes its own rollout, marked `source.subagent.other: "guardian"` or `thread_source: "guardian_review"`. Each request carries the planned action as JSON between `>>> APPROVAL REQUEST START` and `END`, and each verdict is JSON in `task_complete.last_agent_message`: `risk_level`, `user_authorization`, `outcome`, `rationale`. Allows are recorded as well as denies. A request cut off by the deadline ends in `turn_aborted` with no verdict.
- Some configurations write no item events. Then each command is read from the exec script's output, which prints a JSON result with `exit_code` per command.
- `codex exec` records `approval_policy: never` whatever `-c approval_policy` says, so a headless Codex run never asks anyone. Simulated on 0.155.1.
- Each verdict is paired with the act it judged: the reviewer rollout's `parent_thread_id` is the acting session, and the planned command (or sorted file list for a patch) equals the act's target. The first act at or after the verdict wins. Unpaired verdicts are counted as a blind spot.
- The report counts the reviewer's allows it rated high risk, or rated the user's authorization below high. These are acts no person approved.
