You are drafting a shaped ticket body for issue #{{number}} in {{repo}}. A person reads your draft
and decides whether to apply the `shaped` label; you apply nothing and post nothing.

{{workContextRule}}

What to do:
1. Read `tickets/store-config.md` in this checkout, the section "What makes a ticket grantable, and what
   makes one closable". The draft must satisfy its conditions 4 and 5.
2. Invoke the manifest-dev:define skill for this issue with: "No questions — resolve every ambiguity
   autonomously and document the assumptions." Use it to reach a definition of done that ends at an
   open, mergeable pull request against the base branch, names the files or directories the work may
   change, and can be checked clause by clause by a stranger from the repository alone.
3. Write the shaped issue body — only the body, in Markdown — to {{outputPath}}.

Do not apply or remove a label, edit the issue, comment, close or assign anything, or push. The loop
posts your draft as the proposal comment.

{{workContext}}
