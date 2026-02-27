---
name: git-commit
description: Format git commit messages with conventional commit prefixes
---

## Commit Message Format

All git commit messages MUST follow the Conventional Commits specification:

```
<type>: <description>

[optional body]

[optional footer(s)]
```

## Required Prefixes

| Prefix | Use When |
|--------|----------|
| `feat:` | Adding a new feature |
| `fix:` | Fixing a bug |
| `docs:` | Documentation only changes |
| `style:` | Code style changes (formatting, whitespace) |
| `refactor:` | Code changes that neither fix bugs nor add features |
| `perf:` | Performance improvements |
| `test:` | Adding or updating tests |
| `build:` | Changes to build system or dependencies |
| `ci:` | CI/CD configuration changes |
| `chore:` | Other changes (e.g., updating .gitignore) |
| `revert:` | Reverting a previous commit |

## Rules

1. First line must be ≤72 characters
2. Use imperative mood ("add feature" not "added feature")
3. Do not end the subject line with a period
4. Separate subject from body with a blank line
5. Body should explain *what* and *why*, not *how*
6. **NEVER use `--no-verify`** - pre-commit hooks exist for a reason; fix the issue instead
## Examples

Good:
```
feat: add user authentication via OAuth2
fix: resolve race condition in payment processing
docs: update API documentation for v2 endpoints
chore: upgrade dependencies to latest versions
```

Bad:
```
updated stuff
Fixed bug.
WIP
asdf
```

## Breaking Changes

For breaking changes, add `!` after the type or include `BREAKING CHANGE:` in the footer:

```
feat!: remove deprecated API endpoints

BREAKING CHANGE: /api/v1 endpoints have been removed
```
