# Security Policy

ContextPool is local-first, but it can capture sensitive engineering context such as repository paths, diffs, transcript excerpts, commands, and file previews.

## Reporting a Vulnerability

Please report security issues privately before opening a public issue. If no private advisory channel is available yet, contact a maintainer directly and include:

- A concise description of the issue.
- Steps to reproduce.
- Impact and affected versions, if known.
- Any relevant logs or proof of concept, with secrets redacted.

## Local Safety Notes

- The UI binds to `127.0.0.1` by default.
- Do not expose the UI on a public network interface unless you have added appropriate access controls.
- Review context packs and team exports before sharing them externally.
- Raw transcripts are excluded or redacted by default in export paths where possible, but users remain responsible for reviewing generated artifacts.
