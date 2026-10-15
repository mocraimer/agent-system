# Architecture Decision Records

| Date | ADR | Status | Area |
|------|-----|--------|------|
| 2026-09-18 | [A local, GitHub-backed console, and an improve stage that only proposes](20260918-local-console-and-proposing-improve.md) | Accepted | Operator console |
| 2026-10-14 | [The public repository is the only upstream, and every consumer's values live in configuration](20261014-consumer-values-live-in-configuration.md) | Accepted | Release and configuration |
| 2026-10-14 | [Default queue rules are built in, and a target repository may override them](20261014-default-queue-rules-built-in.md) | Accepted | Ticket loop |
| 2026-10-14 | [Prompt proposals open only in a repository the floor names](20261014-prompt-proposals-need-a-named-repository.md) | Accepted | Ticket loop |
| 2026-10-15 | [A build becomes the running system only through a reviewed merge and an explicit operator activation](20261015-activation-needs-merge-and-operator.md) | Accepted | Release and configuration |
| 2026-10-15 | [The loop's policy lives in the target repository's store configuration, read from the fetched base branch on every pass](20261015-loop-policy-read-from-target-base.md) | Accepted | Ticket loop |
| 2026-10-15 | [The operator declares which windows a subscription meters; a usage reading never decides it](20261015-subscription-windows-are-declared.md) | Accepted | Admission |
| 2026-10-15 | [What a runtime does not confirm is recorded as unknown, and requested, resolved and observed settings are kept apart](20261015-unconfirmed-run-settings-are-unknown.md) | Accepted | Run evidence |
| 2026-10-15 | [Merge, auto-merge, force-push, release and production deploy are refused before authority is consulted](20261015-unsafe-actions-refused-before-authority.md) | Accepted | Authority |
