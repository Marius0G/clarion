# Personal pages

`/m` uses the D3 bearer session stored by `/join`; `/m/<token>` retains read compatibility.
`/s` requires the server's staff role (`STAFF_PHONES` or an existing staff profile).

Both runtimes accept `STAFF_ASSIGNMENTS` as a JSON object keyed by E.164 phone:

```json
{"+40711111111":{"role":"hall_agent","zone":"G_CENTER"}}
```

Roles are `security_supervisor`, `hall_agent`, and `incident_commander`. They
identify the staff member; all report observations rather than receiving tasks.
The zone must resolve to a terminal graph node. Stored `staffRole` / `zone` profile
fields are the fallback; an unassigned staff member defaults to security supervisor
in `security`. Assignments never grant the staff role to passengers.

`GET /api/staff` returns the zone's camera situation, local alerts and own reports.
Admin tasks remain in the console; staff task endpoints and WhatsApp tools are removed.
The crowd button posts a `crowd` report for the assigned zone through `/api/reports`.
The existing report form also permits a chosen landmark. Reports feed the existing
journal and D32 P2 alerts. Open staff crowd reports no older than 15 minutes add a
situation-only observation to passenger answers, updates and queue tiles.

Report lifecycle changes use `/api/reports/:id/state` with the operator token.
Reporter notifications respect the existing WhatsApp delivery window; the web
state remains available even if WhatsApp delivery is unavailable.
