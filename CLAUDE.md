# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

AI City Commander is a demo/prototype "smart city" incident-response dashboard for Taipei traffic and crowd
data. A rule engine evaluates traffic/crowd telemetry against a written SOP, and a template-based "LLM adapter"
turns rule-engine output into natural-language alerts and chat answers. There is no real backend or LLM wired
up yet — the frontend is a fully self-contained, 100% client-side simulation driven by static demo datasets.

The repo has two independent parts:
- `frontend/` — the React app described above (this is where almost all work happens).
- `backend/` — AWS Terraform infrastructure + a placeholder Lambda handler, for a future real deployment
  (API Gateway → Lambda → RDS Postgres, optional Bedrock AgentCore). Not used by the frontend today.

## Commands

All frontend commands run from `frontend/`:

```bash
npm install
npm run dev        # Vite dev server, http://localhost:5173/
npm run build      # tsc -b && vite build
npm run preview    # preview production build
npm run test       # vitest run
npm run lint       # oxlint
```

Run a single test file: `npx vitest run src/engine/ruleEngine.test.ts`
Run a single test by name: `npx vitest run -t "some test name"`

Requires a Mapbox token: copy `frontend/.env.example` to `frontend/.env.local` and set `VITE_MAPBOX_TOKEN`
(map features degrade without it, but the token is required for `MapStage`/deck.gl to render).

Backend/Terraform commands live in [backend/README.md](backend/README.md) (bootstrap remote state first, then
`terraform apply` from `backend/terraform/`, which seeds RDS via a private Lambda). There is no application
code to run in `backend/service/` beyond the placeholder connectivity-check handler.

## Architecture (frontend)

**Data flow is one-directional and driven by a single Zustand store** (`src/store/appStore.ts`):

1. `loadAllData()` (`src/data/loadData.ts`) fetches static demo files from `public/data/` at startup: traffic
   CSV, crowd-density CSV, road network JSON (segment graph with `alternatives`/`intersections`), road path
   geometry, live incidents JSON, station coordinates, and the SOP text file.
2. All timestamps across traffic/crowd/incidents are merged into one sorted `ticks` array — this is the
   simulation clock. `advanceTime()`/`seekTime()`/`play()`/`pause()` step through it (see `App.tsx`'s
   `setInterval` loop using `playbackSpeed`).
3. On every tick, `appStore.seekTime()` recomputes per-segment and per-station runtime state, then re-checks
   every SOP rule (city congestion tier, MRT diversion, dome dispersal, multilingual threshold, etc.) by
   diffing "was triggered at previous tick" vs "is triggered now" — alerts only fire on the rising edge of a
   condition, not on every tick it stays true. Incidents from `live_incidents.json` are injected automatically
   once the clock reaches their timestamp (`injectIncident`), or manually via the UI.

**Rule engine (`src/engine/*.ts`) is pure logic, one file per SOP rule**, each mirroring a numbered section of
the SOP at `frontend/public/data/emergency_traffic_sop.txt`:
- `congestionTier.ts` — §1 saturation → Normal/B/A tier, city-trigger-segment response actions.
- `accidentResponse.ts` — §2 accident/roadblock evacuation routing. This is the most involved rule: it decides
  upstream vs downstream alternatives using the segment's `flowDirection` text and the incident's
  location-hint wording (e.g. "南側"/"以北") to compute an insertion index into the ordered `intersections`
  array, then picks the lowest-saturation upstream alternative with `capacityVph >= 1000` as the main
  evacuation route. Read the comments in this file before changing routing logic — the upstream/downstream
  and array-ordering assumptions are load-bearing and non-obvious.
- `mrtDiversion.ts`, `domeDispersal.ts`, `signalFailure.ts`, `multilingualCheck.ts` — §3/§4/§5/§6.
- `ete.ts` — §7 ETE (estimated-time-to-clear) formula: `base_clearance(severity) + congestion_penalty`.

Rule functions are unit-tested against a hand-built mini segment graph in `src/engine/ruleEngine.test.ts`
(mirrors `road_network_geometry.json` shape) rather than the real demo dataset.

**Two-stage "LLM" pipeline, entirely template-based (no network calls):**
- `services/llmAdapter.ts` (`TemplateLLMAdapter`) takes structured rule-engine output (`StructuredEvent`) and
  renders it into Traditional Chinese alert prose, with an artificial delay so the UI can show "rule decision"
  and "LLM generation" as visually separate steps. It also holds canned multilingual (zh/en/ja/ko) SOP message
  templates and a separate "public/citizen mode" answer path that deliberately omits thresholds/SOP references.
- `services/chatEngine.ts` (`runWhatIf`) is the first stage for the chat "what-if" feature: it regex-matches
  the user's free-text question for known scenarios (MRT BL17 numbers, dome peak/growth, roaming %, saturation,
  ETE inputs), re-runs the actual rule-engine function with the extracted numbers, and returns both the
  structured result and the relevant SOP excerpt (via `sopRetrieval.ts`'s keyword scorer) for the adapter to
  narrate.
- Swapping in a real LLM/backend would mean replacing `llmAdapter` and the chat pipeline's second stage;
  `runWhatIf`'s rule re-execution and SOP retrieval are otherwise independent of that.

**Viewer modes**: the whole UI branches on `viewerMode` (`"government"` | `"public"`), persisted to
localStorage. Government mode shows the full dashboard (BottomBar, reasoning chain, SOP refs); public mode
hides operational detail and routes chat through `answerPublic`/`buildPublicContext` instead. Chat message
history is kept per-audience so switching modes doesn't mix the two conversations.

**Map rendering** (`components/MapStage/`) uses `react-map-gl` (Mapbox GL) with deck.gl layers, driven by
`roadPaths` (OSM-derived polylines) and `stationCoords` from the store; segment/station selection state lives
in the store and is shared between the map, `LeftPanel` lists, and `RightPanel` detail views.

Styling is CSS Modules per component (`Component.module.css` colocated with `Component.tsx`); no CSS
framework/utility classes.
