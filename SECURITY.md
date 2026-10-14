# Security

agent-system starts coding agents that can change code, push branches, and open pull requests
under your accounts. A flaw that lets work run without an approval or grant, get past the floor (merge,
force-push, release, production deploy, a read-only project, a required base), or spend past an
admission limit is a security issue.

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue. Include the commit you run (`git rev-parse HEAD`),
what you ran, what happened, and what you expected.

## What is in scope

- The authority and floor checks (`src/core/authorize.ts`, `src/core/authority.ts`, `src/core/floor.ts`).
- Admission and the paid-call ledger (`src/core/admission.ts`, `src/core/ledger.ts`).
- The local control UI and the MCP server, both meant for loopback use only (`src/ui/`, `src/mcp/`).
- How the loop treats ticket and pull request text: as work context, never as instruction.

Problems in the agent CLIs this tool starts, or in GitHub, belong to those projects.
