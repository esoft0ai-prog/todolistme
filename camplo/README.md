# Camplo — web build

Clickable build of the Camplo v2.0 design spec ("See everything. Miss nothing.").
Static HTML/CSS/JS with hash routing and no build step. Deployed to Vercel from this folder.

It is separate from the Finora Android app in the rest of this repo; nothing here is imported by it.

```bash
cd camplo && python3 -m http.server 4173   # open http://localhost:4173
```

Screens: dashboard (morning brief + intelligence feed), lead inbox, lead dossier (live double SLA timer),
campaign detail (overview, leads, pages, insights, notes, logs, SLA, retrospective), pages, SLA, team notes,
my performance, settings (team, AI provider, Telegram, integrations, webhooks & API, notifications),
Camplo Intelligence chat, auth + onboarding, client read-only view and a mobile feed.

All data is demo data in `data.js`; timestamps are relative to page load so timers count live.
