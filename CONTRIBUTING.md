# Contributing

This project favors focused changes with evidence that the resulting behavior is correct. Repository documentation, code identifiers, and commit messages use English.

## Before implementation

The project is in its design phase. Architecture review must precede application scaffolding, dependencies, or runtime configuration. Changes to system boundaries, delivery guarantees, or trust boundaries should include an architecture decision record explaining the context, alternatives, decision, and consequences.

## Keep changes reviewable

Give each change one clear purpose. Include the tests and documentation necessary to understand that purpose. Separate unrelated refactoring, dependency upgrades, and formatting sweeps.

A pull request should explain:

- The problem and resulting behavior.
- Relevant design decisions and tradeoffs.
- How the change was verified, with actual results.
- Known limitations and any migration or operational impact.

Use concrete examples when they make correctness easier to assess. Avoid claims about guarantees or performance without supporting evidence.

## Validation expectations

Match verification to the risk of the change:

- Documentation: check technical consistency, relative links, and whitespace.
- Business rules: test meaningful outcomes and invalid transitions.
- Persistence and messaging: use integration tests for transactions, uniqueness constraints, duplicate delivery, and recovery where affected.
- AI behavior: distinguish deterministic workflow tests from retrieval and real-model quality evaluations. Record the dataset, configuration, and provider needed to interpret results.
- Security boundaries: verify authorization, tenant isolation, and input validation where affected.

Run the relevant automated checks once available. State which checks were not run and why. No application test commands exist at this stage.

Never commit credentials, private customer data, or unredacted sensitive logs. Use fictional fixtures and document required environment variables without secret values.

## Commit messages

Use concise English Conventional Commit messages describing the change:

- docs: define project scope and contribution guidelines
- feat: persist tickets and outbox events atomically
- test: verify duplicate event handling
- fix: recover expired processing leases

Add a body when the reason or tradeoff needs explanation. Keep history focused and avoid rewriting shared history without coordination.

## Review

Changes should be reviewed before merging. Resolve correctness concerns and update affected documentation before considering a change complete. Agent-specific working rules are maintained in [AGENTS.md](AGENTS.md).
