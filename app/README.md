# LRCV Crisis Coordination (web app)

Ops-centre dashboard for Craiova Airport (LRCV). Vite + React 18 + TypeScript + MapLibre GL + zustand. Product spec: `PM/SPEC.md`.

## Run

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # tsc + vite build -> dist/
npm run lint
npx playwright install chromium   # once
npx playwright test               # builds, serves on :4173, runs tests/smoke.spec.ts
```

Deploy target: Cloudflare Pages project `lrcv-crisis` (`wrangler.toml`, output `dist`). Deployment is done by the PM, not by this repo's scripts.

## Structure

- `src/map/` MapLibre setup: layer registry (`layers.ts`), style/fallback (`styles.ts`), layer installer (`addLayers.ts`), click popup (`popup.ts`), `MapView.tsx`
- `src/components/` top bar, scenario rail, right panel tabs, layer toggle panel
- `src/state/store.ts` zustand store (layer visibility, active tab, incident status)
- `src/types/` shared types
- `scripts/` data generators; `public/data/` committed GeoJSON snapshots (app works offline except the basemap, which falls back to a plain dark background)

## Layers (`public/data/*.geojson`)

| Layer | File | Source |
| --- | --- | --- |
| Aerodrome, aprons, taxiways, runway 09/27, terminals, gates, helipads, hangars, stands, navaids, other aeroway | `aerodrome`, `aeroway-*.geojson` | OSM via Overpass |
| Buildings, parking, roads (~3 km), bus stops | `buildings`, `parking`, `roads`, `bus-stops` | OSM via Overpass |
| Taxi ranks, fire stations, hospitals, police (Craiova bbox) | `taxi`, `fire-stations`, `hospitals`, `police` | OSM via Overpass |
| Ops points (ARFF, RVP-N/S, staging, taxi rank, ride-hail, kerb, access entry, ambulance gate, ISU, SCJU) | `ops-points.geojson` | Hand-authored (`scripts/gen-ops-points.mjs`), `approx:true` where assumed |
| 1 km grid A1..H8 (8x8, columns west to east, rows north to south, origin at ARP) | `grid.geojson` | Generated (`scripts/gen-grid.mjs`), approximate, not an official AMC2 grid |

Refresh OSM snapshots: `npm run fetch-osm` (add `-- --resume` to skip files already present). Gates and stand positions are empty in OSM for LRCV; layers exist but have 0 features.

## Licences and attribution

- OSM data: (c) OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright). Attribution is shown in the map; derived GeoJSON snapshots stay under ODbL.
- Basemap: CARTO Dark Matter (c) CARTO, data (c) OpenStreetMap contributors. Free for light use; review CARTO terms before production.
- Operational overlay positions are approximations for demo purposes and must be validated with airport operations.
