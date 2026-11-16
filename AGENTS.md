# Agent working instructions

These instructions apply throughout this repository.

## Commit approval

Documentation-only commits containing Markdown (`.md`) files do not require individual approval. The owner has authorized agents to prepare, validate, and commit these changes autonomously. Keep them focused and report what changed and how it was checked.

This exception applies to documentation content, not executable code or configuration stored in Markdown. Commits containing application code, tests, dependencies, runtime configuration, or other non-documentation changes require the owner's explicit approval of the exact patch before committing.

For changes requiring approval, provide the purpose, affected files, full diff or complete new-file contents, validation results and limitations, and proposed commit message. Include untracked files. If the patch changes after approval, obtain approval for the revised patch.

Commit authorization does not authorize a push, merge, or release. Do not amend commits or rewrite history without explicit authorization.

## Design gate

Do not introduce application code, scaffolding, dependencies, or runtime configuration until the owner has reviewed and approved the architecture. Documentation work may proceed within the agreed scope.

## Working practices

- Follow CONTRIBUTING.md and keep each proposed commit focused on one purpose.
- Use English in repository documentation, code identifiers, and commit messages.
- Preserve unrelated changes and never discard the owner's work.
- Distinguish proposed behavior from implemented and verified behavior.
- Run appropriate checks and report actual results. Do not invent passing tests.
- Do not add credentials, personal data, or private operational information.
