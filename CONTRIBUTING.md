# Contributing

This project favors focused changes with evidence that the resulting behavior is correct. Repository documentation, code identifiers, and commit messages use English.

## Before implementation

The architecture baseline has been accepted. Architecture review must precede application scaffolding, dependencies, or runtime configuration outside that accepted scope. Preparing implementation within the baseline does not replace exact-patch review before code commits. Changes to system boundaries, delivery guarantees, or trust boundaries should include an architecture decision record explaining the context, alternatives, decision, and consequences.

## Keep changes reviewable

Give each change one clear purpose. Include the tests and documentation necessary to understand that purpose. Separate unrelated refactoring, dependency upgrades, and formatting sweeps.

A pull request should explain:

- The problem and resulting behavior.
- Relevant design decisions and tradeoffs.
- How the change was verified, with actual results.
- Known limitations and any migration or operational impact.

Use concrete examples when they make correctness easier to assess. Avoid claims about guarantees or performance without supporting evidence.

## Test-driven development

For business behavior and reliability guarantees, use a short red-green-refactor cycle:

1. Select one agreed acceptance scenario and express its observable outcome as a test.
2. Run it and confirm it fails for the expected missing behavior, rather than an environment or setup error.
3. Implement the smallest change that satisfies the behavior.
4. Refactor while the relevant tests remain green.

Work one behavior at a time rather than writing a speculative suite for the entire system. Prefer tests through stable application boundaries; do not assert private methods or mirror implementation details. Use real PostgreSQL and Kafka integration tests when the guarantee depends on transactions, constraints, offsets, or delivery. Use deterministic model and tool doubles for reproducible execution tests; evaluate real-model quality separately.

Concurrency and recovery tests must coordinate explicit checkpoints and use bounded waits. Avoid relying on arbitrary sleeps. Clock control is appropriate for application timing tests, while lease integration tests must exercise the database-time rules used in production code.

Keep the failing-test step local. Each implementation commit should include its tests and finish with relevant checks passing. Document what failed before implementation and what passed afterward in the review evidence; separate red and green commits are not required.

During the design phase, define acceptance scenarios only. Executable tests and test infrastructure remain subject to the architecture approval gate. TDD is not required for documentation, generated artifacts, or configuration changes that have no meaningful behavioral test.

## Validation expectations

Match verification to the risk of the change:

- Documentation: check technical consistency, relative links, and whitespace.
- Business rules: test meaningful outcomes and invalid transitions.
- Persistence and messaging: use integration tests for transactions, uniqueness constraints, duplicate delivery, and recovery where affected.
- AI behavior: distinguish deterministic workflow tests from retrieval and real-model quality evaluations. Record the dataset, configuration, and provider needed to interpret results.
- Security boundaries: verify authorization, tenant isolation, and input validation where affected.

Run the relevant available checks and state which checks were not run and why. Current commands and boundaries are recorded in the [test strategy](docs/quality/testing.md); a passing foundation check does not establish guarantees outside its verified scope. The complete [phase-2 gate](docs/quality/phase2.md) records the implemented ticket workflow and its acceptance evidence.

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
