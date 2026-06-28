# mendr

Autonomous PR review agent CLI.

This repository is currently a scaffold only.
The planned product will orchestrate review and fix agents for GitHub pull requests.

## Planned CLI

- `mendr <agent> <pr> [--rounds <n>]`
- `mendr ls`
- `mendr view <id>`
- `mendr stop <id>`

## Development

Install dependencies before running scripts.

```sh
npm install
npm run typecheck
npm test
npm run build
```
