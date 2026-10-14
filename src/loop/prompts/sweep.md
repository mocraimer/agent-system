Invoke the manifest-dev:run-ticket skill for {{repo}}#{{number}}.

{{workContextRule}}

This is an unattended dispatch by the coordinator's loop ({{loopName}}), not a person's run.
The loop has already recorded the claim: comment {{claimCommentId}} on the issue, carrying the store's
claim marker and `Claimed by: {{loopName}}`. That is your claim; do not write another.
{{recovery}}

The store configuration is `tickets/store-config.md` in this checkout, a worktree of origin/{{base}}.
Your run ends at an open, mergeable pull request against {{base}} from ticket/{{number}}: open it and
stop. Do not merge, do not close the ticket, do not ask for or run any model review, and never push to
{{base}} or main or force-push. Later stages of the loop take the work further where its stop-line allows.

End every commit message with these lines, exactly as written:
{{commitTrailer}}

{{workContext}}
