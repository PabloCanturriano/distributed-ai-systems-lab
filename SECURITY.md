# Security policy

## Current status

This repository implements a local distributed-systems lab and is preparing its first working release. No application release or production deployment exists, and no version is advertised as security-supported. All example data is intended to be fictional. Do not deploy the planned local lab on a public network without a separate security review.

The controls, implementation scope and trust boundaries are in the [security design](docs/architecture/security.md). Verification and outstanding release controls are recorded in [phase-six readiness](docs/quality/phase6.md); no security-supported release is advertised.

## Reporting a concern

Do not post credentials, private data, or exploit details in a public issue. Use [GitHub private vulnerability reporting](https://github.com/PabloCanturriano/distributed-ai-systems-lab/security/advisories/new). It is enabled for this public repository; the owner receives and triages reports.

Repository visibility and private reporting were enabled and verified on 2026-11-26 under the owner's instruction. No response deadline or security-supported production version is promised.

## Secrets and dependencies

Never commit real API keys, bearer tokens, credential volumes, or sensitive logs. Report accidental exposure privately and revoke the affected credential; deleting a visible file alone does not invalidate a secret.

Dependencies, images, and workflow actions must be reviewed and pinned once implementation begins. Scan findings require documented triage. No security badge or compliance certification is claimed by this policy.
