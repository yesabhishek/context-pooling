# Contributing

Thanks for improving ContextPool.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Use focused tests for parser, store, export, and UI-server behavior. Keep local fixture data out of commits.

## Pull Requests

- Keep changes scoped.
- Include tests for behavior changes.
- Update `README.md` when user-facing commands, APIs, or privacy behavior changes.
- Run the release checks before requesting review:

```sh
npm test
npm run typecheck
npm run build
npm audit --omit=dev
npm pack --dry-run
```

## Security

Do not include real transcripts, tokens, database files, logs, or private repository paths in issues, tests, fixtures, or pull requests. Report security issues privately; see `SECURITY.md`.
