<p align="center">
  <img src="assets/mendr-banner.png" alt="mendr autonomous pull request review workflow banner" width="100%">
</p>

# mendr

[![Release](https://img.shields.io/badge/release-v0.0.0-blue)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Language: TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6.svg)](tsconfig.json)
[![CI](https://github.com/Pepps233/mendr/actions/workflows/ci.yml/badge.svg)](https://github.com/Pepps233/mendr/actions/workflows/ci.yml)

Autonomous pull request code review for terminal-native workflows.

`mendr` is a TypeScript CLI that orchestrates installed coding-agent CLIs as short-lived workers.
Point it at a GitHub pull request, choose `claude` or `codex`, and it runs review and fix rounds until the review agent reports no remaining scoped issues or the configured round cap is reached.

## Project Status

`mendr` is pre-release software at version `0.0.0`.
The repository currently contains the initial CLI, daemon, state, report, agent-driver, and test scaffolding for the planned npm-distributed tool.
The public package target is `npm i -g mendr`.

## Why mendr

Code review agents are most useful when they stay scoped, leave an audit trail, and can be stopped or inspected without keeping a terminal session open.
`mendr` is designed around those constraints:

- It treats the main loop as deterministic TypeScript orchestration, not another long-running LLM session.
- It launches a fresh one-shot review or fix agent process for each step.
- It carries continuity through `report.md`, which is injected into every later prompt.
- It writes review state to disk so `mendr ls` and `mendr view <id>` can inspect in-flight work.
- It posts one final pull request summary comment instead of scattering review noise across the PR.

## How It Works

```text
mendr <agent> <pr>
  |
  +- detached daemon
       |
       +- fetch PR body, comments, and diff with gh
       +- run review agent for scoped issue discovery
       +- run fix agent for each issue
       +- commit and push fixes through the agent workflow
       +- append resolved issues to report.md
       +- repeat until clean or the round cap is reached
       +- post report.md as a single PR comment
```

The review agent is responsible for finding issues strictly inside the pull request's changed scope.
The fix agent is responsible for editing, committing, and pushing a fix for a single issue.
The orchestrator owns the loop, persistence, status events, and final report.

## CLI

```sh
mendr <agent> <pr> [--rounds <n>]
mendr ls
mendr view <id>
mendr stop <id>
```

`agent` must be `claude` or `codex`.
`pr` may be a pull request number or a pull request URL.
`--rounds` and `-r` set the maximum review and fix iterations, with a default of `3`.

## Example

```sh
mendr codex 42
mendr ls
mendr view swift-otter-3f9a
```

After the daemon starts, the original terminal can close.
The review continues in the background, and `view` follows the file-backed status stream.

## Requirements

- Node.js `20` or newer.
- Git.
- GitHub CLI `gh`, installed and authenticated.
- One or both agent CLIs, depending on usage:
  - `claude` for Claude Code.
  - `codex` for Codex.

`mendr` shells out to installed CLIs and uses their existing authentication.
It does not collect API keys or manage model provider credentials.

## Installation

The npm package is not published yet.
For local development:

```sh
npm ci
npm run build
npm link
```

After linking, run:

```sh
mendr --help
```

## Repository Layout

```text
src/
  cli.ts              CLI entry point and subcommands
  daemon.ts           Detached worker entry point
  orchestrator.ts     Review and fix loop
  state.ts            File-backed review state and events
  report.ts           Summary report builder
  github.ts           gh wrapper helpers
  git.ts              git wrapper helpers
  exec.ts             Injectable process boundary
  agents/
    claude.ts         Claude Code driver
    codex.ts          Codex driver
    prompts.ts        Shared prompt construction
    types.ts          Agent driver contracts
test/
  agents/             Agent parser and argument tests
  integration/        Orchestrator and CLI integration tests
  fixtures/           Real-shaped agent output fixtures
```

## State Model

Each review has a durable directory under `~/.mendr/reviews/<id>/`.
The state directory is the source of truth for list and view commands.

```text
~/.mendr/
  reviews/
    <id>/
      meta.json
      state.json
      review.md
      report.md
      events.log
      agent-io/
```

`meta.json` captures immutable run metadata such as agent, pull request, repository, branch, daemon process id, and max rounds.
`state.json` captures the current phase, status, issue counts, completion state, and terminal errors.
`events.log` is append-only JSONL for live status rendering.
`agent-io/` stores raw agent stdout and stderr for debugging.

## Agent Session Model

Every review and fix step starts a new agent process.
For Claude Code, the planned headless invocation uses `claude -p` with JSON output and repository access through `--add-dir`.
For Codex, the planned headless invocation uses `codex exec` with `--sandbox workspace-write`, `-C <repo>`, and final-message capture.

The orchestrator never uses `--continue`, `--resume`, or a reused agent process.
This keeps each step isolated and releases memory when the child process exits.
Continuity comes from `report.md`, which is embedded in every subsequent review and fix prompt.

## Report Format

The final pull request comment is generated from `report.md`.
The report starts with exactly one summary heading and appends one entry per resolved issue.

```md
## Summary
- Issue: <issue found by review agent>
- Resolved by: <commit sha>
- <two sentences on how it was fixed>
```

When the round cap is reached or a fix fails, the report records that state instead of claiming success.

## Development

Install dependencies:

```sh
npm ci
```

Run the local checks:

```sh
npm run typecheck
npm test
npm run build
```

The test suite is designed to be hermetic.
External process calls go through `src/exec.ts`, and tests inject fakes instead of touching real GitHub, Git, or agent CLIs.

## Testing Strategy

The default suite covers unit, integration, and edge-case behavior.
It verifies report idempotency, state JSON round trips, agent output parsing, CLI argument validation, orchestrator loop control, failure handling, and file-backed list and view behavior.

E2E tests are gated behind `MENDR_E2E=1`.
They require `gh`, `git`, `claude`, and `codex` to be installed and authenticated against a disposable GitHub test repository.

## Contributing

Contributions are welcome while the project is still early, but changes should keep the orchestration model deterministic and testable.
Before opening a pull request:

1. Create a focused branch.
2. Add or update tests for behavior changes.
3. Run `npm run typecheck`, `npm test`, and `npm run build`.
4. Follow `.github/pull_request_template.md`.
5. Include clear reasoning for CLI, daemon, agent-driver, state, or report-format changes.

Do not commit generated build output unless a maintainer explicitly asks for it.
Do not edit generated files manually.

## License

`mendr` is released under the MIT License.
See [LICENSE](LICENSE) for details.
