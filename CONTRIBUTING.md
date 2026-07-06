# Contributing

Thanks for considering a contribution to talenox-mcp.

## Workflow

This repo uses a gitflow-style branching model:

```
main → dev → feat/<context>
```

- `main` and `dev` are protected — no direct pushes, all changes go through a
  pull request.
- If you don't have write access to this repo (most contributors won't),
  **fork the repo**, create your branch from `dev` on your fork, and open a
  PR from your fork's branch into this repo's `dev` branch. Never target
  `main` directly.
- Branch naming: `feat/<short-description>` for features, `fix/<short-description>`
  for bug fixes.

## Before opening a PR

1. Run the full test suite and typecheck locally:
   ```bash
   npm test
   npx tsc --noEmit
   ```
2. Every PR runs the same checks in CI (`.github/workflows/test.yml`) and must
   pass before it can merge.
3. Keep PRs focused — one logical change per PR is easier to review than a
   large mixed changeset.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <subject>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.
Example: `fix(auth): handle empty-body responses from Talenox`.

## Reporting bugs

Open a GitHub issue with:
- What you expected to happen vs. what actually happened
- Steps to reproduce
- Relevant logs (redact any real Talenox tokens, client secrets, or employee data first)

## Reporting security issues

Do not open a public issue for security vulnerabilities — see [SECURITY.md](SECURITY.md).
