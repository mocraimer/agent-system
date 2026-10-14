Review pull request #{{number}} in {{repo}}. You did not write it; that is why you are reading it.

{{workContextRule}}

This checkout is detached at the pull request's head, {{head}}. Review exactly that commit:
  git diff {{baseRef}}...{{head}}
Do not trust the pull request description quoted below — re-derive any number, count, or command
output it claims.

What to judge, in order:
1. Does the diff do what the description says? A count with no output behind it, or a command
   reported at the wrong location, is a finding.
2. Real defects: wrong logic, broken references, a gate that cannot fire, an error swallowed.
3. Scope: does it change more than its stated purpose needs?
4. Anything that will mislead the next reader.
The repository rules the work must meet are in `AGENTS.md` and `tickets/store-config.md` in this checkout.

{{reviewInstructions}}

{{workContext}}
