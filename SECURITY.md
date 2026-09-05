# Security

Kicksmash stores little (names, match data, optional email or phone) and has no passwords, but it does send email and calendar invites on people's behalf, so abuse and privacy issues matter.

## Reporting a vulnerability

Please do **not** open a public issue. Email the address shown on https://kicksma.sh/about with:

- what you found and where (URL, action, or file),
- steps to reproduce,
- the impact you believe it has.

You will get a reply within a few days. Fixes ship as soon as they are ready; there is no bounty program, but credit is given in the changelog if you want it.

## What is in scope

- Access to another player's data or matches without their link (personal links and organizer links are the credentials).
- Sending email to people who did not ask for it, or bypassing the unsubscribe list and rate limits.
- Signature or cookie forgery (`/unsubscribe`, `km_player` session cookie, personal tokens).
- Anything on the hosted service at kicksma.sh that would affect other users.

## Out of scope

- Denial of service or volume-based attacks against the hosted service.
- Issues that need physical access to an unlocked device.
- Reports from automated scanners without a demonstrated impact.

## Built-in protections

- Per-IP and per-player rate limits on identity creation, match creation, joins, invitations, email changes and code requests.
- HMAC-signed unsubscribe links; a one-tap opt-out list that organizer-initiated email respects.
- httpOnly, signed session cookie; personal tokens are 12 random characters with the previous token honored after rotation.
- One-time 6-digit email codes with per-address rate limits and lockout after repeated wrong attempts.
