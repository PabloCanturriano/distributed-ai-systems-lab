# ADR-0003: Keep local AI repeatable and real-provider evaluation separate

Status: proposed; subject to the final architecture review.

## Context

A reviewer should run the system without obtaining model credentials, downloading a large model, or paying for requests. Deterministic output is useful for recovery tests but cannot establish real-model quality.

## Decision

Provide a scripted local model adapter by default, with explicit simulated labels in CLI output, traces, and reports. It exercises the same tool-validation and persistence boundaries as real-provider execution, but scripts model decisions for repeatable scenarios.

Keep retrieval in PostgreSQL with pgvector. The default offline embedding profile is a deterministic lexical hashing baseline; document its algorithm and limitations before implementation. It makes vector retrieval executable without a downloaded model. It is not a semantic embedding model. Use exact similarity search for the small corpus; defer approximate indexing until query evidence justifies it. [pgvector supports exact and approximate search](https://github.com/pgvector/pgvector).

Add a real-provider adapter only as an explicit opt-in with fictional data, reviewed outbound hosts, execution limits, and separate generation/embedding profile identifiers. Provider and model IDs must be recorded in evaluation reports; no specific commercial model is selected by this ADR.

## Alternatives and consequences

An embedded open-weight model would provide genuine offline inference but adds download size, hardware variance, licensing review, and setup friction. Making it mandatory conflicts with the first-run goal. Hosted-only inference conflicts with credential-free evaluation.

The lexical baseline may rank paraphrases poorly. Report that result honestly and compare it with a real embedding profile when available. Never compare vectors from different profiles or treat passing scripted answers as evidence of language-model reasoning.

A separate vector database could support larger-scale retrieval, but it adds a stateful dependency without a demonstrated need. Reopen this decision if measured workload or functionality requires it.
