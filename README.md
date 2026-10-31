# Clarion: Airport Crisis Orchestration

Crisis coordination platform for airport operations centres: sensor alert, authorised decision, playbook, then notifying and coordinating passengers on their way, taxis and ride-hailing, 112/ISU, airlines and staff, with live acknowledgements, a regulator timeline and a Unity 3D drill mode. Built at Craiova Hackathon V2.0 for the CONTROL TOWER challenge.

- `docs/ROLURI.md`: who does what until Sunday 15:00
- `app/PM/`: build spec, backlog and status
- `bogdan-research/`: research synthesis, deep research reports and the prompts used
- `docs/research/`: research reports (impact, anti-drone systems, notification channels, simulation data)
- `docs/simulare-agenti-ai.md`: how people in the simulation decide
- `whatsapp/`: WhatsApp alert templates and the script that validates and submits them to Meta

## WhatsApp

Get `.env` from the team (it is not in git) or copy `.env.example`, then:

```
node whatsapp/submit-templates.mjs --preview   # messages filled in with examples
node whatsapp/submit-templates.mjs --status    # review status
```

Requires Node 20.12 or newer.
