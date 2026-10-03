# anahid

`anahid` reads the Claude Code and Codex transcripts already on your machine and tells you what refused each tool call: you, a settings rule, a hook, auto mode, the sandbox or a built-in check.

```
npx anahid
```

It needs Node 22 or later. It runs no other program, sends nothing and writes nothing.

## What it shows

This is part of the report from one machine that runs many agents, often unattended and in subagents, for transcripts from 2026-08-31 to 2026-10-03. A machine where one person works with one agent will look different. The full report also lists repositories, who answers for each act, and what the record cannot see.

```
Claude Code, 912 transcripts, 76,233 tool calls, 2026-08-31 to 2026-10-03

Refused: 407 calls (95 inside subagents)
  person            6  a person said no
  unanswered       83  approval was requested and nobody answered (50 asked by built-in checks, 33 inferred)
  rule              4  a permission rule in settings
  hook              6  a PreToolUse hook blocked it
  classifier      215  an automatic classifier or reviewer
  builtin          93  a built-in safety check

Auto mode
     180  blocked by the classifier
            14  Production Deploy
            13  Modify Shared Resources
             9  Remote Shell Writes
             7  Production Reads
             7  Git Destructive
            48  23 other reasons, in --json
            82  no reason given
      33  the classifier could not answer, so the call was refused without a judgement
       1  a separate safety check refused it over earlier conversation content
       1  a safety classifier stopped it while it ran; it may have completed

Claude Code labelled 75 of these "user-rejected". A person refused 6.
101 refusals carry a vendor label that names the wrong layer.
```

On this machine auto mode refused more calls than everything else together. 33 of its refusals were not judgements: the classifier could not answer, and the call was refused anyway. [Claude Code's documentation](https://code.claude.com/docs/en/permission-modes) says some of these are denied with no notification and no entry under Recently denied in `/permissions`.

## Why the vendor's labels are not enough

Claude Code labels an approval request that nobody could answer, for example inside a subagent or a headless run, `user-rejected`, the same as a person saying no. On the machine above, 75 refusals carry that label: 6 were a person, 62 were approval requests nobody answered, and 7 were built-in checks. Hook blocks and settings rules share another label, `permission-rule`.

Codex does not save a person's approval decisions. Its automatic reviewer saves every verdict, allows included. On the machine above it judged 1,027 approval requests, and 993 actions ran on its allow alone, with no person asked.

## In scripts and CI

`claude -p` exits 0 when a tool call was refused. Point `anahid` at the run's transcript and name the layers that should fail the job:

```
anahid ~/.claude/projects/<project>/<session>.jsonl --fail-on unanswered,classifier
```

It exits 1 if one of those layers refused a call, or if nothing was scanned.

## What the record cannot see

Every report ends with this section, even when nothing was refused. It names what applies to your machine, such as:

- Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default).
- A PreToolUse hook that times out lets the call run unchecked. Those calls are counted.
- Calls with no recorded result are counted.
- A model that declines before calling a tool leaves nothing to count.
- The transcript format is undocumented and changes between versions. The report names the versions it was tested on.
- Every layer other than the vendor's own label is inferred from message text. Inferred counts are marked.

## Who answers

A declaration names who answers for a project. It is an `anahid.declaration/3` file, the same format the Anahid product uses, and this tool reads only the part it needs: the people, the agents and who owns them, and where each agent works.

```json
{
  "schema": "anahid.declaration/3",
  "humans": { "alice": { "name": "Alice Example", "role": "Head of Platform" } },
  "agents": {
    "cc": { "owner": "alice" },
    "cx": { "owner": null }
  },
  "sources": {
    "claude": { "kind": "claude-code-hooks", "agent": "cc", "path": "~/code/payments" },
    "codex":  { "kind": "codex-hooks", "agent": "cx", "path": "~/code/payments" }
  }
}
```

Put one file per project in `~/.anahid/declarations/` (`$ANAHID_HOME/declarations/` when set), or pass `--declaration <file or directory>`, more than once if needed. An agent answers to its `owner`, or else to its `parent` agent's owner.

The report then counts calls, refusals and reviewer-only allows per person, and two kinds of act nobody answers for:

- **undeclared**: no declaration covers the directory.
- **unaccountable**: a declaration covers it, but the agent's chain reaches no person. In the example, Codex's acts in `~/code/payments` are unaccountable.

## What it reads and prints

- It reads `~/.claude/projects`, `~/.codex/sessions` and `~/.codex/archived_sessions` (under `CLAUDE_CONFIG_DIR` and `CODEX_HOME` when set), `~/.claude/settings.json` for the retention setting, and the declarations.
- It reads the `.git` folder or file of each working directory named in the transcripts, to group worktrees by repository.
- By default the report quotes no command or message. `--examples 1` adds one example per layer with its file and line. Those quote real commands, so check them for secrets before you share a report.
- The report names your repositories, and with a declaration, the people in it. `--json` writes your home directory as `~`.

## Options

```
anahid [refusals] [transcript.jsonl ...]
  --engine <name>     claude-code, codex or all (default: all that have transcripts)
  --since <date|Nd>   only calls on or after a date (2026-09-01) or N days ago (7d)
  --examples <n>      examples per layer, with file:line (default 0)
  --declaration <p>   an anahid.declaration/3 file or a directory of them; may repeat
  --json              machine-readable output, schema anahid.refusals/1 (spec/refusals.schema.json)
  --fail-on <layers>  exit 1 if one of these layers refused a call, or nothing was scanned
  --version           the version
  -h, --help          usage
```

Exit codes: 0 report printed, 1 a `--fail-on` layer refused a call or nothing was scanned, 2 bad arguments or declaration, 3 the scan failed.

## How it decides

Each agent has a table of message signatures in `spec/signatures/`, and each signature is pinned by a test vector in `spec/vectors/`. A refusal is placed in the first layer whose signature matches. An error that matches no signature and carries no denial label is a plain tool failure, not a refusal. A denial label with no matching signature is reported as `unknown`, never guessed.

When a new agent version changes a message, the fix is a table entry and a vector, not code. If your report shows `unknown`, please open an issue with the message text and the agent version, with anything private removed.

## This tool and the Anahid product

This tool is the open part of Anahid. Reading and checking records on your own machine stays here, under Apache-2.0, with no account and nothing sent anywhere. The paid Anahid product is a separate install that runs on your own servers. This tool never needs it.

Not affiliated with Anthropic or OpenAI. Claude Code is a product of Anthropic, Codex of OpenAI.

## Status

Early. Claude Code and Codex only. All numbers so far come from one machine. Tested on Claude Code 2.1.245 to 2.1.288 and Codex 0.149.0 to 0.155.1.

## How it was built

Written with Claude Code, Codex, Hermes, pi, a custom harness running local models, and other coding agents.

## License

Apache-2.0. Copyright 2026 Mohammad Karimi.
