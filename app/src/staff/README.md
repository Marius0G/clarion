# Personal pages

`/m` uses the D3 bearer session stored by `/join`; `/m/<token>` retains read compatibility.
`/s` requires the server's staff role (`STAFF_PHONES` or an existing staff profile).

Both runtimes accept `STAFF_ASSIGNMENTS` as a JSON object keyed by E.164 phone:

```json
{"+40711111111":{"role":"hall_agent","zone":"G_CENTER"}}
```

Roles are `security_supervisor` (lane tasks), `hall_agent` (redirects), and
`incident_commander` (evacuations). The zone must resolve to a terminal graph node.
Stored `staffRole` / `zone` profile fields are the fallback; an unassigned staff
member defaults to security supervisor in `security`. Assignments never grant
the staff role to passengers.

Staff confirmations and completion update `staffState` on the same ops records
read by the console. Unity acknowledgements and camera evidence remain separate.
Report lifecycle changes use `/api/reports/:id/state` with the operator token.
Reporter notifications respect the existing WhatsApp delivery window; the web
state remains available even if WhatsApp delivery is unavailable.
