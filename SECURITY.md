# Security

Version 0.1.x is the initial supported release line. This project has not undergone an independent security audit.

Report vulnerabilities privately to the repository owner. Once the project has a GitHub repository, enable private vulnerability reporting and use its Security → Advisories page. Until a private contact exists, do not post credentials or exploit details in a public issue.

Operational boundaries:

- One process per SQLite data directory; no distributed consistency or tenant onboarding.
- Keep the dashboard on a trusted network. Use HTTPS and COOKIE_SECURE=true for team access.
- The complete data directory, including encryption.key, is sensitive. Anyone who can read the database and that key can decrypt provider secrets.
- Virtual keys grant model access; administrative sessions grant dashboard access. Assign the owner role only to trusted operators.
- Allow private upstream URLs only when trusted administrators control provider configuration.
- Guardrails match selected input patterns. They are not comprehensive moderation or prompt-injection defenses.
- Token admission uses a conservative estimate. Provider tokenization, pricing and usage reporting can differ.
- Demo credentials are public and belong only in the isolated demo.

Release packaging uses explicit file lists, dependency locks, artifact checksums and package-content checks. Python extraction rejects paths outside the package and all links/special files. Containers run as a non-root user; Compose uses a read-only root filesystem and a writable named data volume.
