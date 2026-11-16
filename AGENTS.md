# Agent working instructions

These instructions apply throughout this repository.

## Approval before every commit

The repository owner must review and explicitly approve the exact proposed changes before each commit. Editing or preparing files does not authorize committing them.

Before requesting approval, provide the purpose, affected files, full diff or complete new-file contents, validation results and limitations, and proposed commit message. Include untracked files in the review material.

If the patch changes after approval, obtain approval for the revised patch. Commit approval does not authorize a push, merge, or release. Do not amend commits or rewrite history without explicit authorization.

## Design gate

Do not introduce application code, scaffolding, dependencies, or runtime configuration until the owner has reviewed and approved the architecture. Documentation work may proceed within the agreed scope.

## Working practices

- Follow CONTRIBUTING.md and keep each proposed commit focused on one purpose.
- Use English in repository documentation, code identifiers, and commit messages.
- Preserve unrelated changes and never discard the owner's work.
- Distinguish proposed behavior from implemented and verified behavior.
- Run appropriate checks and report actual results. Do not invent passing tests.
- Do not add credentials, personal data, or private operational information.
