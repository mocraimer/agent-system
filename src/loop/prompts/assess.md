You are assessing the ungranted tickets of {{effortLabel}} in {{repo}}. You propose; a person decides.

{{workContextRule}}

This checkout is {{base}} at {{baseSha}}. Read `tickets/store-config.md` here: its section "What makes a
ticket grantable, and what makes one closable" is the only test you apply. Do not restate its
conditions — apply them.

Reach exactly one verdict for each ticket quoted below, and for no others: {{ticketList}}.
Check the repository as it stands in this checkout for anything you assert about its state. A ticket
saying a condition holds is not evidence that it still does. A "should be closed" verdict needs the
number of the ticket it duplicates, or what this checkout shows — never the prose of the ticket being
judged. When a claim rests on running something, give the command, the directory, its exit status and
the deciding output lines verbatim.

Group the verdicts, give each the evidence it requires, and say plainly when a group is empty, so a
person can grant and close from your text alone. Write it in Markdown to {{outputPath}}.

After the verdict prose, append one `CLOSE_VERDICT:` line for every ticket you judged should be
closed, using exactly one of these forms:

    CLOSE_VERDICT: ticket=#N kind=duplicate dup=#M
    CLOSE_VERDICT: ticket=#N kind=already-done
    CLOSE_VERDICT: ticket=#N kind=no-longer-true

Replace `#N` with the ticket number and `#M` with the number it duplicates. Write no `CLOSE_VERDICT:`
line for a ticket you did not judge should be closed, and no line for a ticket that lacks a duplicate
number (for `kind=duplicate`) or prose evidence in the section above.

Do not add or remove a label, close or reopen anything, edit a ticket, comment, or push. The loop posts
your text as the one assessment comment.

{{workContext}}
