# Security

## Reporting a bypass

If you find a request that reaches PHP through the shield and still triggers
PHP2Shell, or a false negative in `php2shell-check`, please report it privately
through GitHub's "Report a vulnerability" button on this repository rather than
in a public issue. Include the request shape, not a working exploit against a
third party.

## Scope

This project narrows the published PHP2Shell vectors. It does not fix PHP.
A bypass of a vector that was never published is still worth reporting, but
the answer will usually be "upgrade PHP", which is the only complete fix.
