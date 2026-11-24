# Security policy

Infra Control can power machines on and off and start or stop cloud instances, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") on this repository.

Include what you found, how to reproduce it and which commit you tested. You will get an answer as soon as possible;
this is a personal project, so there is no formal SLA.

## Design notes that matter for reports

- Single user, session cookie (`Secure`, `HttpOnly`, `SameSite=Strict`) and an exact `Origin` check on human writes.
- Agents and PC reporters use separate bearer tokens, stored only as SHA-256 hashes, with narrow scopes.
- Power commands are a closed list; nothing accepts a shell, a destination or free arguments.
- The panel never stores your machines' SSH keys inside the container; the privileged broker runs on the host.
- Never expose the panel without HTTPS. Keep the private configuration outside the repository.

## Out of scope

Findings that require control of the host, of the private configuration or of a reporter token are expected to be
catastrophic by design and are not considered bugs of the panel itself.
