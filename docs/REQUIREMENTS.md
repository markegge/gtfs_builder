# GTFS·X — Requirements

## Overview

GTFS·X is a web application for creating, editing, analysing, and publishing GTFS (and GTFS-Flex) transit feeds. It targets small-to-mid-sized transit agencies and the consultants who serve them. The primary surface is a Mapbox-backed editor where alignments are drawn before stops are placed; analysis features let users size service against demand, demographics, and cost; and a backend tier handles accounts, multi-agency workspaces, publication, and embeddable rider-facing widgets.

### Status snapshot

| | |
|---|---|
| **Editor (anonymous, IndexedDB-only)** | Live in production at https://www.gtfsx.com. Two-rail layout (responsive left nav + configuration right rail). Mobile-responsive editor layout shipped (Phase 1 + Phase 2): all editing and analysis panels reachable at phone width; panel opens full-screen; bottom bar surfaces Timetable/Visualization/Validation. Map drawing and vertex drag remain mouse-optimized (touch-draw on roadmap). |
| **Backend (auth, projects, orgs, publication, embeds, billing, forum)** | **Live in production since 2026-05-15** with live-mode Stripe billing. The `BACKEND_ENABLED`/`BILLING_ENABLED` kill-switches (client and worker) were removed on 2026-07-12 as legacy; both are always on. Staging is parked, manual rehearsal only. |
| **Plans** | Free ("Editor") / Agency ("Planner") / Enterprise, self-serve via Stripe Checkout. See [§3.7](#37-billing-and-subscription-plans). |
| **Source of truth** | `main` — every push auto-deploys to production via Cloudflare Workers Builds. |

If you are picking this project up cold: read this overview, then [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) §5 for the live operational picture, then the section below that matches the area you're working in.

---

## How this document is organized

Five sections corresponding to the major capability areas:

1. **GTFS feed editing** — the map + form + timetable workflows that produce a valid GTFS feed.
2. **Analysis and route development** — the things you do *with* a feed before you publish it: demand dots, demographic coverage, Title VI equity, stop-level diagnostics (spacing, balancing, service intensity, accessibility), cost estimation.
3. **Account, organization & billing** — auth, orgs, multi-tenant workspaces, branding, subscription plans, admin console.
4. **Feed publication and distribution** — snapshots, canonical publish, draft links, catalog submissions, and rider-facing embeds + mini-site.
5. **Community forum** — the public Q&A / discussion forum.

Within each section, capabilities are marked:

- ✅ **Shipped** — built and exercised in production.
- 🟡 **Partial** — modelled, with known gaps tracked elsewhere.
- 🔲 **Planned** — specced but not built (tracked in GitHub issues).
- 🚫 **Deferred** — considered and deliberately skipped.

Detailed architecture, data model, API surface, and runbooks live in [`ARCHITECTURE.md`](./ARCHITECTURE.md); the backlog of 🔲 planned features lives in GitHub issues. This file is intentionally short — it's the orientation map, not the territory.

---

## 1. GTFS feed editing

### 1.1 GTFS spec coverage

Required and core-optional files are first-class entities in the editor:

| File | Status |
|---|---|
| `agency.txt` | ✅ |
| `stops.txt` | ✅ |
| `routes.txt` | ✅ |
| `trips.txt` | ✅ |
| `stop_times.txt` | ✅ |
| `calendar.txt` | ✅ |
| `calendar_dates.txt` | ✅ |
| `shapes.txt` | ✅ |
| `feed_info.txt` | ✅ |
| `fare_attributes.txt` / `fare_rules.txt` (GTFS-Fares v1) | ✅ |
| GTFS-Fares v2 (`areas.txt`, `stop_areas.txt`, `networks.txt`, `route_networks.txt`, `timeframes.txt`, `rider_categories.txt`, `fare_media.txt`, `fare_products.txt`, `fare_leg_rules.txt`, `fare_transfer_rules.txt`) | 🟡 — Phase 1 round-trip only; see [§1.6](#16-fares) |
| `directions.txt` (auto-emitted from per-route direction names) | ✅ |
| `frequencies.txt` (headway-based service) | ✅ |
| `transfers.txt` | ✅ |
| `pathways.txt` / `levels.txt` (multi-level stations) | ✅ |
| GTFS-Flex (`locations.geojson`, `booking_rules.txt`, `location_groups.txt`, extended `stop_times`) | ✅ — see [§1.7](#17-gtfs-flex-demand-responsive-service) |

### 1.2 Routes and shapes

The editor enforces a **route-first** workflow: alignment is drawn before stops are placed. This supports rapid iteration on alignments — important for analysis features that compare candidate alignments against demand and demographics.

- ✅ Route metadata (short/long name, color picker, GTFS route type, agency, URL).
- ✅ Polyline drawing with vertex add/remove/drag.
- ✅ Snap-to-road via the Mapbox Map Matching API. When a path can't be fully matched (it leaves the road network), both the draw flow and the Routes panel's per-shape **Snap** button warn before discarding geometry: the user can keep the current/unsnapped shape or snap anyway. The Routes-panel warning also summarizes the current vs snapped shape length (and the difference, in miles) so the user can judge the loss before confirming.
- ✅ Freehand drawing for off-road segments.
- ✅ Multiple shape variants per route (e.g., inbound vs outbound; loops); each shape carries an editable display name (UI-only label, not exported).
- ✅ `shape_dist_traveled` auto-calculated on export.
- ✅ Per-route hidden/visible toggle on the map.
- ✅ Route delete cascades trips, `stop_times`, `route_stops`, fare rules, and shapes only used by this route. Stops unique to the route are deleted by default; user can opt out via the delete confirmation dialog to preserve them as standalone stops in `stops.txt` (useful when reassigning to a different route).
- ✅ **Generate shapes from stops** — repair recipe for a feed with no route geometry (`shapes.txt`): reconstructs one shape per unique served-stop sequence, snapped to the road network via Mapbox Map Matching (or connected with straight lines, for off-road alignments), and links the new `shape_id` onto every trip sharing that pattern. Two entry points: an import-time callout for a freshly-imported feed with no shapes (the common gap in feeds from Excel-style builders such as National RTAP's GTFS Builder, which treats shapes.txt as an optional step), and a Validation-panel recipe (§1.8) any time after. Undoable in one step; the result summary flags patterns that only partially matched the road network, or fell back to straight lines, for manual review/edit in this panel. Available on every plan (no gating).

### 1.3 Stops

Stops are placed in the context of the currently-selected route. Default behaviour mimics curbside placement: the stop snaps to the route line and renders offset to the right-hand side relative to direction of travel.

- ✅ Click-to-place along the active route; snaps to nearest point on the route line.
- ✅ Right-hand offset rendering (curbside convention) per direction.
- ✅ Freehand stop placement for off-route stops (park-and-rides, transfer points).
- ✅ Drag to reposition; snapped stops re-snap, freehand stops move freely.
- ✅ Stop attributes: name, code, description, lat/lon, wheelchair boarding.
- ✅ Multi-route stops — stops can be assigned to additional routes via an "Add existing" stop picker.
- ✅ Repeated stops in one pattern — a stop may appear more than once in a single route/pattern (loops / out-and-backs where first = last stop). The "Add existing" picker no longer hides already-added stops; each instance is an independent timetable column and exports as a repeated `stop_id` at a distinct `stop_sequence`.
- ✅ Reorder stops along a route via drag-and-drop.
- ✅ Parent station / location_type hierarchy — editable on the stop (location type, parent station, `level_id`); a **Stations** panel adds table editors for `levels.txt` (floors) and `pathways.txt` (in-station walkways/stairs/elevators), with FK + enum validation.
- ✅ Stop names labelled on the map at appropriate zoom levels.

### 1.4 Calendars and service patterns

- ✅ Day-of-week toggles + start/end date.
- ✅ `calendar_dates` exception editor (added/removed days), with a "Delete all" control (two-step confirm) to clear every exception for a service at once.
- ✅ Bulk-add common US holidays (MLK Day, Presidents' Day, Memorial Day, July 4, Labor Day, Thanksgiving, Christmas, etc.) within the active service date range.
- ✅ Visual calendar showing which services run on which dates, with exception days colour-coded.
- ✅ Human-readable service summary ("Weekdays", "Saturday Only", custom day patterns) — surfaced both inside the editor and on rider-facing embeds.
- ✅ Validation nudge (soft warning) when a service runs on a major US holiday inside its active range with no `calendar_dates` exception — covers fixed-date + nth-weekday holidays incl. Juneteenth.

### 1.5 Trips and timetables

- ✅ Per-route timetable grid (rows = trips, columns = stops, cells = times).
- ✅ "Edit Stops" shortcut in the timetable toolbar opens the route's Stops editor; clicking a stop on the map opens its properties panel directly. The route's **Stops tab** has the reverse jump — an "Open timetable editor" button (mirror of the Trips tab's button).
- ✅ Trip metadata: headsign, direction, service pattern, block_id, wheelchair_accessible.
- ✅ Auto-interpolate intermediate stop times from distance + speed.
- ✅ Estimate stop times from the drawn route's road-network travel time (Mapbox Map Matching, `◷` per trip): per-stop travel along the matched path + a configurable per-stop dwell (default 18 s) and bus-vs-car speed factor (default 1.3). Fill one trip, then ⇶ to all.
- ✅ Apply a trip's stop sequence + relative timing to every other trip on the route/direction (`⇶`), each keeping its own start time.
- ✅ Duplicate a trip with a configurable time offset (e.g. "repeat every 30 min").
- ✅ **Generate service from a headway** (B1, `timetableGen.ts`) — on an empty pattern, enter a window + headway + end-to-end run time and get evenly-spaced trips (or a `frequencies.txt` window). The run time is pre-filled from the shape length; intermediate stops interpolated by distance. The "Generate service" form is the timetable's empty-state and a route Trips-tab entry.
- ✅ **Running-time editor** (B2, `runtimes.ts`) — set a pattern's end-to-end run time and re-time every trip on it, each keeping its start (headways intact).
- ✅ **Scheduling in the map pane** — a `centerView` switcher (Map / Timetable / Blocks) renders the timetable builder and the blocking Gantt in the center pane; the map stays mounted-but-hidden.
- ✅ Bidirectional editing — changes in the timetable reflect on the map and vice versa.
- ✅ Service summary showing weekly revenue hours, trips per week, peak vehicles per route.
- ✅ Per-stop departures view ("departures from this stop today").
- ✅ Frequency-based (headway) service entry (`frequencies.txt`) — per-trip windows with overlap/validity checks, in the Frequencies panel.
- ✅ Block assignment UI — `block_id` is first-class: editable per trip, with a Blocks panel grouping trips by block and a soft overlap warning.
- ✅ **Vehicle-blocking Gantt** (B3, `BlockGantt` + `blockBuilder.ts`) — a vehicle-row × time-axis view in the center pane: trip bars by route, layover gaps, deadhead connectors, ID / platform-hours / pull-out / pull-in columns, a day-type selector, and a cost header (vehicles, peak-in-service, daily/annual cost split into service/layover/deadhead with toggles). **Quick Block** greedily auto-chains feasible trips (editable, no optimizer); **Interline** allows cross-route chaining; drag a trip to reassign its vehicle; overlaps flag red and surface as a pre-publish validation warning.
- ✅ Marey diagram (time–distance trip chart).

### 1.6 Fares

Fare information is **strongly encouraged**. Empty-fare feeds are flagged prominently; export emits a warning.

#### 1.6.1 GTFS-Fares v1 — shipped

- ✅ Fare attributes (price, currency, payment method, transfer policy, transfer duration).
- ✅ Fare rules — flat-route fares, zone-to-zone matrices.
- ✅ Multiple fare types (regular, reduced, etc., via additional `fare_id`s).
- ✅ Empty-fare warning banner + export-time validation warning.
- 🟡 Zone editor — basic zone assignment per stop is supported; no map-drawing zone editor yet.

#### 1.6.2 GTFS-Fares v2 — Phase 1 shipped, Phases 2/3 planned

GTFS-Fares v2 is a parallel set of files alongside v1; consumers prefer v2 when present. Most agencies serving Google/Apple/MobilityData ingestors today publish both during a transition window. The editor's v2 work is staged:

**Phase 1 — round-trip preservation (shipped).** A v2-aware feed imported into the editor is preserved on export. Round-trip integration test (`run-tests.ts` Phase 12) asserts every v2 file survives import → export → re-import without data loss.

- ✅ Types for all 10 v2 entities in `src/types/gtfs.ts`.
- ✅ Store slice `src/store/fareV2Slice.ts` holding parsed rows.
- ✅ Import (`gtfsImport.ts`) parses `areas.txt`, `stop_areas.txt`, `networks.txt`, `route_networks.txt`, `timeframes.txt`, `rider_categories.txt`, `fare_media.txt`, `fare_products.txt`, `fare_leg_rules.txt`, `fare_transfer_rules.txt`.
- ✅ Export (`gtfsExport.ts`) emits each file when populated; v1 and v2 coexist in the same ZIP.
- ✅ Persistence layer (`persistence.ts`, `serverPersistence.ts`) snapshots the v2 state alongside the rest of the editor.

**Phase 2 — editor UI (in progress).** Authoring requires new panels because the v2 cross-references go several levels deep. Gated behind a per-feed **"Fares v2"** feature toggle (Settings panel): off by default, auto-on when the imported feed already carries any v2 file. When on, v2 authoring tabs appear in the Fares panel (alongside Fares / Zones / Transfers). Recommended build order, each piece blocked on the prior:

- ✅ **Fares v2 toggle** — `featuresSlice.ts` `faresV2` key + `FeatureSettingsPanel.tsx`; gates the v2 authoring tabs. Off by default; auto-on if the feed has v2 files.
- ✅ **Areas editor** — `src/components/fares/AreasEditor.tsx` (Fares panel → Areas tab). Create / rename / delete areas (area_id unique, area_name optional) and assign/unassign stops (stop_areas.txt). CRUD lives in `fareV2Slice.ts`.
- 🔲 Networks editor — group routes for fare purposes.
- 🔲 Rider Categories editor — first-class records for adult / senior / student / child.
- 🔲 Fare Media editor — cash vs smart card vs cEMV vs mobile app.
- 🔲 Fare Products editor — the actual purchasable thing, joining categories and media to prices.
- 🔲 Timeframes editor — peak/off-peak windows tied to service_ids.
- 🔲 Leg Rules editor — which (area + network + timeframe + rider category) combo costs which fare product.
- 🔲 Transfer Rules editor — free / discounted / time-bounded transfer pricing. Distinct from `transfers.txt` (routing semantics) — these are fare rules. Lives under the Fares panel when built.

**Phase 3 — validation (in progress).** v2's referential integrity is dense and bad references silently break trip-planner fare display.

- ✅ Areas: `area_id` unique in areas.txt; every stop_areas row references an existing area and an existing stop (orphan / missing-stop errors); duplicate (area, stop) mapping warned. In `validation.ts`.
- 🔲 Cross-reference checks: `fare_leg_rules.fare_product_id` exists in `fare_products`; `fare_leg_rules.network_id` exists in `networks`; same for `area_id`, `timeframe_group_id`, etc.
- 🔲 Validation that every route is covered by at least one applicable leg rule (or surface a "no fare defined for route X" warning analogous to the v1 check).
- 🔲 Detect v1/v2 conflicts when both are present (e.g. a route priced differently in v1 and v2).

Why staged: the editor's target audience is small and mid-size agencies whose immediate need is the ability to import a v2 feed (often handed to them by a state DOT or a consultant) and round-trip it without data loss. The editor UI is the long pole and adds little value until an agency is actually authoring v2 from scratch — which most aren't yet. Phases 2/3 land as the install base of v2-authoring agencies grows.

### 1.7 GTFS-Flex (demand-responsive service)

Full GTFS-Flex authoring is shipped (`src/store/flexSlice.ts`, `gtfsImport.ts` / `gtfsExport.ts`, `src/components/flex/`):

- ✅ `locations.geojson` polygon zones. One zone = one location: a zone is exported as a single Feature with a top-level `id` (the zone id), and a multi-polygon zone merges into one `MultiPolygon` Feature. Properties are limited to the spec's `stop_name` / `stop_desc`.
- ✅ `booking_rules.txt` (booking type, prior-notice durations, `prior_notice_service_id`, contact info, messages) per zone.
- ✅ Extended `stop_times` (location_id, pickup/drop_off booking rule ids, pickup/drop-off windows, pickup/drop-off types). Travel within one zone correctly emits the **two** records the spec requires, both carrying the window and neither carrying an arrival/departure time.
- ✅ `location_groups.txt` + `location_group_stops.txt`. A zone may be polygon, group, or **mixed** (polygon + group on one trip = travel from a zone to a group).
- ✅ `continuous_pickup` / `continuous_drop_off` (route-level + per-`stop_time` fields).
- ✅ Additional service windows per zone (e.g. morning + evening shuttles); `safe_duration_factor` / `safe_duration_offset` on `trips.txt`.
- ✅ `calendar_dates` exception handling; flex zones create a `route_type` 715 route (715, 1551, 1564 all selectable).
- ✅ Zone ↔ route ↔ service_id linkage preserved on round-trip; validation + pre-export checks for incomplete zones. Zones with no pickup window are skipped entirely on export (no orphan geometry or booking rules in the zip).
- ✅ Per-`stop_time` continuous pickup/drop-off overrides surfaced in the timetable UI (flag icon in each stop header → popover; overrides the route default per stop, applied across the route's trips; round-trips through import/export).
- 🔲 Import a GeoJSON boundary file as a zone (today a zone must be drawn, buffered, or arrive via a GTFS zip). Tracked as #56.
- 🔲 Editor UI for `pickup_type` / `drop_off_type`, `prior_notice_start_day` / `_time`, `pickup_message` / `drop_off_message`; booking-rule reuse across zones. All round-trip through import/export today, but have no editor. Tracked as #58.

Note: `mean_duration_factor` / `mean_duration_offset` are **not** GTFS fields (they were dropped before Flex merged into the base spec). They are still parsed from legacy feeds but are no longer written to the zip or exposed in the UI. The real spec fields are `safe_duration_factor` / `safe_duration_offset` on `trips.txt`.

### 1.8 Validation, import, export

- ✅ Real-time validator running against canonical GTFS rules — surfaces errors (block export) and warnings (exportable but flagged).
- ✅ Accessibility completeness check — a single aggregate warning when board points are missing `wheelchair_boarding`; cross-links to the per-route breakdown in Stop Analysis (§2.5).
- ✅ Click-to-navigate from a validation message to the offending entity.
- ✅ **Group-by-type + batch fix** — the Validation panel toggles between **Individual** (flat list) and **By type** (one row per rule, with a `N×` count and how many are auto-fixable). Grouping keys on a message's stable rule `code` when it has one, else a template derived by blanking entity ids/numbers, so a feed with hundreds of the same error (e.g. 832 trips "missing arrival_time or departure_time") collapses to one summary row. **By type** is the default at ≥50 active messages; the user can flip freely. Groups expand to their individual messages (paged so an expanded group never mounts hundreds of DOM rows), each still click-to-navigate and individually fixable. A **right-rail fix recipe** shows the catalog `description` for the selected rule's fix (or a "no automatic fix" note) with **Fix this one** and **Fix all N of this type**; the batch applies the per-message fix to every fixable message in the group as a single undoable step ("Fixed X of N", reporting the already-fine remainder), and the list re-validates automatically. `services/validationGrouping.ts` (aggregation) + `applyValidationFixBatch` in `services/validationFixes.ts` (combined undo). Does not regress dismiss-by-code (the dismissible-rule groups carry their code and expose a single dismiss affordance).
- ✅ **Interactive fix recipes** — a catalog `ValidationFix` can be `interactive` (no `apply`) when its remedy needs a dialog rather than a one-click mutation (network calls, a mode choice, a progress readout). The panel opens that dialog instead of applying anything, and the recipe is excluded from the batch **Fix all N** affordance (it can only be run interactively, once, feed-wide). First (and so far only) user: **Generate shapes from stops** (§1.2), the fix for the "no route geometry" warning.
- ✅ Auto-fix path in the export dialog for orphan references (trips → missing routes, stop_times → missing stops, etc.).
- ✅ Import GTFS ZIP — parses every supported file and populates the editor. **Unknown columns and unknown files are dropped, not preserved.** `gtfsParse.ts` maps each entity through an explicit named-field allowlist and reads a fixed file list; anything outside it (a custom column, a non-GTFS file shipped alongside the standard ones) is silently discarded and does not reappear on export. Round-trip fidelity is therefore "every file/field the editor *supports* survives" (which includes the ones it has no authoring UI for — Fares v2, `directions.txt`, `pathways.txt`, `levels.txt`), not "everything survives". The one non-spec column that survives is `external_id` on `agency.txt` (next bullet) — and only because it is no longer "unknown": it is an explicit, named field on the `Agency` entity (`Agency.external_id`), parsed per row like any other agency field and written back by the ordinary exporter. It is not a general passthrough. Preserving genuinely-unknown columns/files would need a raw passthrough store the parser doesn't have; tracked as a gap, not a shipped behavior.
- ✅ Export GTFS ZIP — emits every populated file. Every stop in editor state is written to `stops.txt`, including unreferenced ones (the validator already warns on unused stops, so users still get the nudge).
- ✅ **NTD `agency_id` warnings (FTA)** — two dismissible warnings backing FTA's [July 10, 2025 final notice](https://www.federalregister.gov/documents/2025/07/10/2025-12813/national-transit-database-reporting-changes-and-clarifications-for-report-years-2025-and-2026) (FR 2025-12813), which made `agency_id` **non-conditional** for NTD reporters — including in `routes.txt` — because FTA crosswalks a published feed to the agency's NTD ID on `agency_id`. `ntd-missing-agency-id`: per-entity, fires on a multi-agency feed where an `agency.txt` row or a `routes.txt` row has no `agency_id` (a genuine spec violation, not merely an NTD one). `ntd-single-agency-no-agency-id`: advisory, emitted **once per feed** (never per route) when a single-agency feed omits `agency_id` — spec-legal, but FTA cannot crosswalk it. Separate codes so the two dismiss independently. In `validation.ts`.
- ✅ **`Agency.external_id` — the agency's NTD / external identifier.** The ID belongs to the **agency**, not the project: an optional field on the `Agency` entity, edited in the **Agency panel** ("NTD / External ID", with an (i) link to `/docs/ntd-id/`). **Free-form string** — no format rule, because leading zeros are significant (`00123`) and the field may carry a non-NTD identifier; never `Number()`-coerced. Exported as an `external_id` column on `agency.txt` **automatically, with no opt-in**, whenever any agency has a non-empty value; when none do, the column is omitted and `agency.txt` is byte-identical to a feed that never knew the field. It falls out of the ordinary exporter (`stripUIFields` drops `undefined`, `toCSV` takes the union of row keys) — there is no special-case code path. Read back **per agency row** on import, so a multi-agency feed keeps each agency's own ID. **Provisional extension field, NOT part of the GTFS spec** (a proposal is pending; the column name may change — tracked as [#62](https://github.com/GTFS-X/gtfsx/issues/62)). The name is deliberately generic: the column carries whatever external identifier an agency is known by, of which an NTD ID is the common case.
- ✅ **Multi-agency editing** — the Agency panel manages **every** agency in the feed, not just `agencies[0]`. One agency renders as the plain form it always was; two or more add an **Editing** picker above it, so each agency's fields (including its own `external_id` and its `agency_id`) are editable. **+ Add Agency** seeds a new row (generated `agency_id`, timezone inherited from the feed's first agency) from the form as well as the empty state. **Delete** is offered only when nothing references the agency — routes/fares pointing at it block it with a stated reason, because `removeAgencyAt` deliberately does not cascade (a route on a vanished `agency_id` is a broken feed). Rows are addressed **by index**, not by id (`updateAgencyAt` / `renameAgencyIdAt` / `removeAgencyAt` in `agencySlice`): `agency_id` is only conditionally required by the spec, so an imported feed can carry blank or duplicate ids and an id-addressed write would edit the wrong agency. Editing `agency_id` is an explicit **rename** (draft + confirm button, matching the Fares v2 id editors) that cascades to `routes.txt` + `fare_attributes.txt`. Routes gain an **Operated by** selector (`RouteEditor`) once the feed has 2+ agencies — the spec requires `agency_id` on every route there, and it's how FTA crosswalks a route to its operator.
- ✅ **Validator-parity check (#4)** — a DEV/QA harness (`npm run test:validator-parity`, `tests/external/validator-parity.ts`), *not* a product feature. It runs **our** validator and the canonical **MobilityData** GTFS validator (hosted, v8.x) over **our own** test feeds (the bundled streamline feed plus a deliberately-broken variant) and prints a per-feed parity diff: issues both catch, issues MobilityData catches that we miss (our gaps — the key output), and issues only we flag. A code↔code mapping table (`validator-parity-mapping.ts`) reconciles the two notice vocabularies and is the core deliverable; uncovered canonical codes are listed as explicit TODOs. **Network-dependent and periodic — NOT in the fast CI gate.** It exits non-zero only on *new* gaps versus an in-repo baseline (`validator-parity-baseline.json`), so a MobilityData ruleset bump doesn't make it flaky. Grow the feed list + mapping table as we add spec features (Fares v2, flex, …). (We do **not** ship a user-facing "validate against MobilityData" button — that would upload users' feeds to a third party; parity is verified by us, on our feeds, in CI-adjacent tooling.)

### 1.9 Per-feed feature settings

Advanced GTFS features clutter the editor for small agencies that don't use them, so they're gated behind a per-feed **Settings** panel (gear in the left rail). A feature is shown when the user turns it on *or* the feed already contains its data ("the feed has the file enables it"). Settings live with the feed (working-state snapshot — IndexedDB + server R2), not a database setting, and never change the exported GTFS. Turning a feature off warns and clears its data.

- ✅ Gated, **off by default**: Transfers (a Fares sub-tab), Frequencies, Stations (`levels.txt`/`pathways.txt`), Blocks (`block_id` — a trips column, no file), **Fares v2** (gates the v2 authoring tabs in the Fares panel; auto-on when the feed already carries v2 files; see [§1.6.2](#162-gtfs-fares-v2--phase-1-shipped-phases-23-planned)).
- ✅ **Demand response / paratransit** — GTFS-Flex; **on by default** to drive Flex adoption. Off hides Flex Zones. A soft (non-blocking) validation nudge fires when it's on but the feed has no flex zones.
- ✅ Import seeds the settings from the feed's contents; gated nav sections (and the Transfers tab) hide/show accordingly.
- 🔲 Emitting header-only empty files on export for enabled-but-empty features (full bare-zip round-trip of the on-state) — deferred; needs import-side file-manifest detection and trips validator "empty file" notices.

### 1.10 Undo / redo (edit history)

Session-scoped undo/redo over feed-data edits, so destructive or hard-to-reverse operations (move a stop, reroute/snap a shape, retime a trip, delete an entity, bulk fills, "estimate times" overwrites) have an escape hatch.

- ✅ **Patch-based history** — the store's Immer middleware is wrapped (`src/store/historyMiddleware.ts`) so every recipe `set` captures Immer inverse-patches; undo applies the inverse, redo re-applies the forward patch (`src/store/history.ts`). Patches (not full snapshots) keep memory bounded by the size of each change, not the size of the feed.
- ✅ **Feed-data only** — agencies, stops, routes, trips, stop_times, shapes, calendars, fares (v1 + v2), transfers, frequencies, levels/pathways and flex zones are undoable (`HISTORY_KEYS`). Ephemeral UI state (selection, panels, map mode, hover), feed variants, validation results, feature toggles and project metadata never enter the history.
- ✅ **Coalescing** — rapid same-target fine-grained edits (a stop drag's many position writes, typing in a field) within a short window collapse into one undo step.
- ✅ **Bounded depth** — the stack is capped (oldest dropped past the limit) so large feeds can't balloon memory.
- ✅ **Feed-boundary reset** — importing or opening a different feed (or switching a variant / restoring a snapshot) resets the history so undo can't cross feed boundaries.
- ✅ **Affordances** — undo/redo buttons in the editor top bar (disabled when the respective stack is empty, with tooltips), keyboard shortcuts **Cmd/Ctrl+Z** / **Cmd/Ctrl+Shift+Z** (suppressed while focus is in a text input/textarea/contenteditable), and a short toast naming the reverted/re-applied action.
- ✅ **Session-scoped** — nothing extra is persisted; the Dexie auto-save layer remains the durability source of truth (an undo is autosaved like any other edit).

---

## 2. Analysis and route development

The editor is also a planning tool. These features answer "where should we run service?" and "what would it cost?" alongside the basic editing flow. They run client-side against in-memory feed state plus bundled or fetched reference data.

### 2.1 Demand dot map

A nationwide vector-tile layer of dot-density transit demand, served from R2 PMTiles via the Cloudflare Worker.

The layer draws **two named groups**, because *propensity* (who will ride) and *need* (who depends on transit) are different questions and conflating them is what made the previous model wrong:

- **Ridership propensity** = zero-vehicle households (`B25044`) ∪ low income, <200% FPL (`C17002`). Car access is the one strongly-supported demand predictor (CUTR 1998: 5.9× the national per-capita transit-use rate); income is supported but weaker and partly mediated by it.
- **Transit need** = the above ∪ seniors 65+ (`B01001`) ∪ adults 18+ with a disability (`C21007`). The transit-dependence tradition, used for equity/coverage work. Seniors and the disabled belong here on dependence grounds — seniors are *under*-represented among actual riders (0.41×, APTA) — so this group must never be read as a ridership signal.
- **Jobs** (LODES WAC, all sectors) — a separate universe (counted at the workplace), never deduplicated against the population groups.
- **Everyone else** — the neutral remainder backdrop.

**One dot = one PERSON, not one dot per group they belong to.** Every population dot in the tiles carries its four membership flags as a packed integer (`d`: bit 1 carless, 2 low_income, 4 senior, 8 disability; `d = 16` is a job). The composites are unions of those flags, **evaluated at render time**, so they are not tile classes at all. Consequence, and the reason the schema exists: **every person is drawn exactly once, in every view.**

UI: a propensity/need mode switch, a radio for **All** (the deduplicated union) vs. a **single segment** at a time, plus independent Jobs and "Everyone else" checkboxes. Picking a segment **recolors rather than filters** — the selected flag goes strong blue, the *rest of the composite* goes muted blue (they are on the map; they are not "everyone else"), everyone else goes gray, jobs stay orange. Segment + rest-of-composite + backdrop is the whole resident population, always, at every zoom the layer draws at (z8 and in).

Dot density is **zoom-scaled and baked into the tiles** (Mapbox GL forbids `["zoom"]` in a filter): 1 dot ≈ 160 people at z8, ≈ 10 at z12, ≈ 5 at z13+. The panel reports the ratio for the current zoom from the legend, never a hardcoded constant, and `verify_tiles.py` proves the tiles honor it before publication.

**Deduplication is measured, not assumed.** The segments overlap (a person can be carless *and* low-income *and* disabled). Published ACS tables give only marginals, so the union is derived from **Census PUMS microdata** (2020–2024 5-yr, 2,462 PUMAs), which is person-level and shows the intersections directly; each block group inherits its PUMA's overlap structure. Validated against a state→PUMA hold-out (a harsher test than PUMA→block-group): median error ~1.3% (propensity) / ~1.7% (need). The full 16-cell **joint distribution** is tabulated straight from PUMS person records per PUMA (a headcount, not an inference) and fitted by IPF to each block group's own ACS marginals, which is what lets a dot carry a *combination* of flags without reimposing independence.

> **The old ×0.6 dedup factor is gone.** It appears in no published work, and measured against PUMS it was wrong by ~34% and wrong in a *geographically structured* way — the true overlap ranges from ~0.55 to ~0.95 across PUMAs, so a single constant over-counts in dense high-overlap areas and under-counts nearly everywhere else. **Renters** were also cut (no causal mechanism; 73% of carless people are renters, so tenure largely restates car access — LA Metro's own index excludes tenure for the same reason), as were **adults 18–24** (APTA: 20–24s are at parity among riders, not elevated; the college-town effect is a fare/parking-policy effect, not an age effect) and **youth under 18** (it pushed the need union to 59% of the population, making the map read like a population map). Race/ethnicity is deliberately never a predictor — that's what the Title VI panel (§2.3) is for.

Resolution: TIGER block (TABBLOCK20) geometries, with ACS variables apportioned from block group → block by 2020 block population, falling back to housing units then land area where population is unusable. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) Appendix A for the build pipeline + yearly regen runbook. Public docs, with the full literature citations: [`/docs/rider-propensity/`](https://www.gtfsx.com/docs/rider-propensity/).

- ⚠️ **Live in prod: `us-2026e`** (attribute dots), served at `/_demand-tiles/<archive>/{z}/{x}/{y}.pbf`. **`us-2026f` — a 4x denser zoom ladder, same tile schema — is built and verified but NOT yet uploaded to R2, and `demand-legend.json` already names it**, so the archive must reach R2 before that legend ships to prod or every demand tile 404s. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) §5.
- ✅ Toggleable map layer (`DemandDotsLayer.tsx`), flag/mode/segment vocabulary in `demandCategories.ts`, legend + zoom ladder parsed from the pipeline's `demand-legend.json` by `demandLegend.ts` (which refuses to start if the flag bits disagree with the tiles, and disables the layer with a reason when the legend is an older schema).
- 🚫 Demand dots are **display only** — explicitly not wired into coverage / Title VI analysis. The analysis pipeline uses ACS tract centroids for apportionment to keep methodology stable.
- ✅ **Reconciled with the Coverage panel.** `src/services/demographics.ts` dropped the old `highPropensityRiders` metric (renters ∪ zero-vehicle ∪ 18–24, ×0.6) entirely rather than keep a second, hand-mirrored model. Coverage's propensity/need figures now come from the exact census-block layer (§2.2, `blockCoverage.ts` / `us.fgb`), computed by the same PUMS estimator (`puma_union.py`) as this dot layer, so Coverage and the dot map can no longer disagree about what "high propensity" means. `/docs/demographic-coverage/` (public docs) has been brought in line with the two-group model alongside this change.

### 2.2 Demographic coverage

Apportioned **buffer coverage** — for the system, each route, or a single stop, how many people / households / workers live within a configurable straight-line buffer (¼ mi default, ½ mi for light rail). ACS block-group totals are apportioned via a circle–circle overlap formula (`coverageAnalysis.ts`), not a binary centroid-in-buffer test. Straight-line buffers approximate walking reach; **street-network walksheds** (Mapbox walking isochrones) are an Agency+ option that swaps the circle buffer for the real reachable area — see below.

- ✅ Tract centroids bundled per state in `public/census/TR<FIPS>.txt` (CORS-free); block groups inherit their parent tract's centroid.
- ✅ ACS 5-year (2022) variables fetched live from `api.census.gov` (`demographics.ts`): population (B01003), housing units (B25001), workers (B08301), race/ethnicity (B03002), low-income <200% FPL (C17002), zero-vehicle households (B25044), and age 65+/under-18 (B01001). Variables are chosen to be tabulated at **block-group** geography — tract-only tables (B08201 vehicles, B09001 under-18) are deliberately avoided because they return null at block-group level.
- ✅ `CoveragePanel` (system + per-route) with covered population/household/worker totals plus a **demographic profile** table reporting five equity shares (minority, low-income, zero-vehicle, senior, youth) as coverage-vs-county-baseline ratios.
- ✅ Per-stop Coverage tab (`StopCoveragePanel`) — distance to adjacent stops on each route, plus this stop's own buffer demographics and equity shares.
- ✅ Map overlay shading the covered block-group buffers.
- ✅ **Network-distance walksheds (Agency+)** — `network_walksheds` feature key (Agency/Enterprise, lockstep in `planConfig.ts` + `worker/billing/plans.ts`). The Coverage panel offers a "Network walksheds (street distance)" toggle + walk-time picker (5/10/15 min ≈ ¼/½/¾ mi); free users see a disabled control with the standard upgrade link. When on, `networkWalkshed.ts` fetches a Mapbox **walking Isochrone** per distinct stop (deduped by rounded coord, in-memory cached, capped at 200 requests/analysis), unions them with `@turf/union`, and apportions block groups against the polygon (ring-sampled circle–polygon overlap) through the **same** `coverageFromFractions` summation — so demographics update identically, just with tighter geometry. Graceful fallback to the straight-line buffer (with a notice) on API error/timeout or over the request cap; the result records which geometry was used so headers/labels stay honest.
- ✅ **Exact block-level layer (nationwide, 50 states + DC)** — `blockCoverage.ts` loads a prebuilt FlatGeobuf of one point per census block (`us.fgb`, built by `demand-dots/coverage-pipeline/`, same PUMS estimator as the dot layer) and tabulates the blocks whose centroid falls inside the walkshed, for both the system-level and per-route Coverage totals. Gives precise population/jobs/equity counts — plus block-level LODES jobs — instead of the tract-centroid disc apportionment above; falls back to it silently on any load failure (layer not deployed locally, fetch error). Surfaces the `carless`/`disability` segment counts and the `prop_all`/`need_all` propensity/need estimates alongside the equity-share table. ⚠️ The client already expects the current two-group schema and throws `CoverageLayerSchemaError` on an older one; regenerating the live `us.fgb` is a separate, manual, hours-long step — see [`ARCHITECTURE.md`](./ARCHITECTURE.md) Appendix A for status and the regen runbook.

### 2.3 Title VI equity analysis

Implements the FTA Title VI service-equity methodology (Circular 4702.1B): apportions daily trips per stop to nearby block groups, classifies block groups against a regional threshold, and reports the ratio of average daily trips received by each group.

- ✅ End-to-end calculation in `titleVI.ts` reusing `coverageAnalysis`'s overlap math.
- ✅ Minority / non-minority comparison against the regional minority share (FTA Circular 4702.1B).
- ✅ Low-income (Environmental Justice) comparison alongside it — block groups classified against the regional <200% FPL share (C17002), same apportioned-trips methodology.
- ✅ `TitleVIPanel` summarising per-group population, average daily trips, and both ratios (a ratio below ~0.80 flags a potential disparity).

### 2.4 Cost estimation

Estimates annual operating cost from feed structure + per-route inputs.

- ✅ Per-route UI fields for cost-per-revenue-hour and vehicles-required (stored as `_cost_per_revenue_hour` / `_vehicles_required` UI-only fields, ignored on export).
- ✅ Computes weekly revenue hours, peak vehicles, weekly cost — broken out per service pattern and rolled up to annual.
- ✅ `CostSummary` panel surfaces the totals.
- ✅ Scenario comparison ("what if we add a Saturday run?") — via **feed variants** (§2.7): fork the feed, edit a variant, then `diffFeedState` (`feedDiff.ts`) reports Δ revenue-hours / peak vehicles / trips / weekly+annual cost plus a per-route changeset against the baseline.
- ✅ Deadhead-factor inputs beyond a global multiplier — **block-derived cost** (`calculateBlockCost`, §2.6): real service / layover / deadhead hours from the block geometry when blocks exist, with per-bucket cost toggles; falls back to the flat factor otherwise.

### 2.5 Stop analysis

A dedicated **Stop Analysis** panel (`StopAnalysisPanel`, gated under the `analysis_basic` plan) with four collapsible, CSV-exportable diagnostics computed client-side from the in-memory feed (`stopAnalysis.ts`). All thresholds are UI-configurable. Inter-stop distance is great-circle (Haversine) in feet — `shape_dist_traveled` is intentionally not used, because GTFS leaves its unit undefined and it can't be trusted across arbitrary feeds.

- ✅ **Stop spacing distribution** — system histogram + per-route medians of consecutive-stop spacing on each route's dominant trip pattern (longest trip per direction), compared against APTA / TransitWiki benchmarks (too-close < 600 ft, target ~750–1,320 ft, hard max 2,640 ft).
- ✅ **Stop balancing candidates** — consecutive same-route pairs closer than a threshold (default 600 ft), flagged for consolidation with an order-of-magnitude daily time saving (dwell seconds × trips/day). Terminals and stations are excluded; the lower-service stop is the removal candidate.
- ✅ **Service intensity per stop** — trips/day, span of service, and peak vs. off-peak median headway on the busiest weekday (or a chosen service day). Also surfaced on the per-stop Trips tab.
- ✅ **Accessibility completeness** — share of board points with `wheelchair_boarding` populated, plus a per-route breakdown of the gaps; cross-links to the validator warning (§1.8).
- ✅ Contextual map highlighting (`StopAnalysisLayer`): amber removal candidates, a trips/day colour ramp, and accessibility-gap pins.
- 🚫 Stop-level ridership estimates — deliberately not synthesised; honest answer requires APC data.

### 2.6 Vehicle blocking & block-derived cost

Light, **good-enough** vehicle blocking for small agencies — no optimizer, no runcutting. See [`/docs/service-planning/`](https://www.gtfsx.com/docs/service-planning/).

- ✅ **Blocking Gantt** (`BlockGantt`, center pane via `centerView='blocks'`) — vehicle-row × time-axis: trip bars by `route_color`, layover gaps, deadhead connectors, ID / platform-hours / pull-out / pull-in columns, day-type selector.
- ✅ **Quick Block heuristic** (`blockBuilder.ts`, pure) — greedy first-feasible, minimize vehicles: no overlap, deadhead-reachable within the gap (straight-line ÷ speed), idle ≤ maxLayover, same `route_id` unless interlining. Output always passes the overlap check. Fully editable: drag a trip to another vehicle, or Interline / Unblock.
- ✅ **Block-derived cost** (`calculateBlockCost`) — per day-type service / layover / deadhead hours from block geometry, with Cost-layover / Cost-deadhead toggles; falls back to the flat `deadheadFactor` when no blocks exist (regression-safe). Header also shows peak-in-service (`calculateSystemPeakVehicles`) and a vehicles-over-day histogram.
- ✅ **Feasibility** — `findBlockOverlaps` (promoted from `BlocksPanel`'s sweep) flags same-`(block_id, service_id)` overlaps in the Gantt and as a **pre-publish validation warning**.
- 🔲 Crew scheduling / runcutting (B4) — explicitly deferred; a possible Part 3.

### 2.7 Feed variants & comparison

Fork the feed into editable variants and compare their cost against a baseline ("what does this change cost vs. today?"). Agency-gated. See [`/docs/service-planning/`](https://www.gtfsx.com/docs/service-planning/).

- ✅ **Variants** (`variantSlice` + `services/variants.ts`) — fork "from current", name, switch the active variant, mark a baseline; a banner shows when editing a non-baseline variant. **Client-side and session-scoped** (not in the working-state blob), so the existing save path is untouched. (Server-side persistence — migration `0023_feed_scenario` + endpoints — is mapped and deferred; see the implementation notes.)
- ✅ **Feed-state diff** (`feedDiff.ts`, pure, E1) — `diffFeedState(a,b)`: added/removed/changed per entity + headline deltas (Δ revenue-hours, peak vehicles, trips, weekly/annual cost via `calculateSystemStats`) + a per-route changeset.
- ✅ **Compare-to-baseline UI** (`VariantCompareDialog`) — KPI delta strip + per-route changeset. Closes the long-planned "Scenario comparison" (§2.4).

### 2.8 Transit access isochrones

Schedule-based travel-time reach: from an origin pin, where can a rider go on the network in N minutes (walk access + wait + in-vehicle + routed walk egress), with the population/jobs/equity reachable inside each contour. Agency-gated (`access_isochrones` feature key, lockstep in `planConfig.ts` + `worker/billing/plans.ts`). See [`/docs/access-isochrones/`](https://www.gtfsx.com/docs/access-isochrones/).

- ✅ **RAPTOR router** (`services/accessIsochrone/raptor.ts`) — in-browser earliest-arrival over `stop_times`; route patterns by stop sequence, per-round boarding snapshot, `frequencies.txt` expansion, service-day filtering. 30 unit tests.
- ✅ **Orchestrator** (`services/accessIsochrone/orchestrator.ts`) — straight-line walk access seeds RAPTOR; per-budget egress drawn as **routed street-network walksheds** (Mapbox isochrones via `walkshedForStops`, same engine as §2.2 network walksheds); opportunities apportioned through `coverageFromWalkshed`.
- ✅ **UI** (`AccessIsochronePanel` + `AccessIsochroneLayer`) — origin pin (`place_access_origin` map mode, draggable), budget/departure/service-day/walk controls, nested single-hue stepped-saturation contours with on-map time labels, per-ring population/jobs/equity readout. `accessIsochroneSlice`.
- Phase-2 deferred (per #40): departure-window averaging, scenario before/after diff, per-tract accessibility surface, block-level LODES jobs, PNG/CSV export, Web Worker offload.

---

## 3. Account, organization & billing

Architecture, data model, full API surface, and live operational state are in [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) (§2 data model, §3 API, §5 live state).

The backend tier is implemented as a single Cloudflare Worker that also serves the SPA's static assets and the public feeds origin. D1 holds metadata; R2 holds working-state JSON, snapshots, GTFS zips, org logos, and feed thumbnails; KV holds rate-limit counters.

### 3.1 Authentication

- ✅ Email + password signup with email verification.
- ✅ Magic-link login.
- ✅ Password reset.
- ✅ Logout (per-session) + logout-all-devices.
- ✅ HTTP-only `Secure SameSite=Lax` session cookies; idle (30d) + absolute (90d) timeouts.
- ✅ Cloudflare Turnstile captcha gate on `/auth/signup` (Managed mode; site key public, secret as Worker secret).
- ✅ Rate limits on all `/auth/*` endpoints (KV-backed, per IP + per email).
- ✅ Account settings: change name, email (with re-verify), password, soft-delete account.
- ⚠️ Password hashing is PBKDF2-HMAC-SHA256 @ 100k iterations (workerd cap). Argon2id migration (**NF-40a**) should land before broad RTAP distribution; details in [`ARCHITECTURE.md`](./ARCHITECTURE.md) §4 / §9. Tracked in GitHub issues.
- ✅ Google OAuth ("Sign in with Google").
- ✅ **Optional two-factor authentication** (2026-07-23, off by default): email 6-digit codes at sign-in (password + Google OAuth; magic link exempt — it already proves the email factor). Enable/disable in Account → Security, each confirmed by a code round-trip. Org admins can set **Require 2FA for all members** (org settings → Security); members of a requiring org are challenged via email at every sign-in even if unenrolled, and cannot disable 2FA. Codes: 10 min TTL, 5 attempts, 60s resend cooldown, hashed at rest (D1 `twofa_challenge`), KV rate-limited. Public docs: `/docs/two-factor-authentication`.
- 🔲 SMS 2FA via **Twilio Verify** — **code-complete, awaiting Twilio account setup only.** Phone enrollment (E.164 + consent evidence), SMS as a selectable method, login/magic-link SMS challenges, and mocked-Twilio tests are all implemented; everything returns `sms_unavailable` until the three secrets exist. Activation: paid Twilio account + Trust Hub profile + a Verify Service (no A2P 10DLC/carrier application needed for verification-only traffic), then `wrangler secret put` `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_VERIFY_SERVICE_SID`.
- ✅ **SMS security alerts** (transactional, A2P 10DLC): opted-in users (verified phone + consent) get a text on a new-device sign-in (heuristic: no prior session in 90 days shares the user agent; capped at 2/user/day) and whenever 2FA is turned off. Best-effort and never blocks the login/disable it rides on; audited as `user.sms_alert_sent` (kind only, never the body/number). Gated on `TWILIO_MESSAGING_SERVICE_SID` (the approved Messaging Service `MG…`) plus the API-key trio; inert until set. Code in `worker/sms/alerts.ts`.

### 3.2 Organizations

- ✅ Create / rename / delete (soft-delete) orgs.
- ✅ Membership roles: `owner`, `admin`, `editor`, `viewer`. Many-to-many — one user can belong to multiple orgs (consultant case is a primary scenario).
- ✅ Invitation flow (email-based; consumer signs up if needed and joins on accept).
- ✅ Ownership transfer; last-owner protection.
- ✅ Org settings page at `/orgs/<slug>` — members, roles, invitations, branding.
- 🔲 Per-project membership granularity (a user scoped to a single project inside an org) is not built. Tracked in GitHub issues (BE-95).

### 3.3 Workspaces and feed ownership

- ✅ A feed project is owned by either a user (personal) or an org. Slug uniqueness is per `(owner_type, owner_id)`.
- ✅ Workspace switcher in the top bar; `My Feeds` page is workspace-scoped.
- ✅ Cross-workspace feed transfer: kebab → "Move to…" with workspace picker (Personal + every org where the user is editor+). Auto-suffixes the slug on collision; updates `publication.canonical_slug` in lockstep so a published feed's URL keeps pointing at the same project after a move.
- ✅ Anonymous → signed-in import: local IndexedDB projects can be uploaded to the server on first sign-in; collision/quota prompts.

### 3.4 Quotas and abuse controls

- ✅ **Plan-based quotas** (`worker/projects/quotas.ts`), enforced as soft-warn at the 90% threshold (`HARD_LIMITS=true` flips to hard rejection — for the eventual RTAP licensing model):

  | Plan | Saved projects | Snapshots / project | Max ZIP | Published feeds |
  |---|---|---|---|---|
  | Free | 3 | 5 | 20 MB | 0 |
  | Agency ("Planner") | unlimited | 50 | 100 MB | unlimited |
  | Enterprise | unlimited | 200 | 200 MB | unlimited |

- ✅ Per-IP + per-email rate limits on auth endpoints.
- ✅ Turnstile signup gate.
- ✅ CSRF defense via `X-GB-Client` header on state-changing endpoints.
- ✅ Admin can disable / re-enable users (§3.5).
- 🔲 Further abuse controls (freeze new signups by IP, take down a user's publications). Tracked in GitHub issues.

### 3.5 Admin console

- ✅ Routes under `/admin` gated on `user.staff = 1`; non-staff get 404 (not 403) to avoid surface enumeration.
- ✅ Dashboard counters (users by status, orgs, projects, snapshots, publications, signups this week/month, active-user proxy via session activity, subscription tier breakdown).
- ✅ Users: paginated table, filter by status + email substring, row actions (disable / re-enable, resend verification, impersonate).
- ✅ Orgs: paginated table, member-role management.
- ✅ Audit log: filtered + paginated viewer with CSV export.
- ✅ Events: cookieless page-view analytics. Inbound `?ref=` tag captured once per session (stripped from the URL), tallied on `/admin/events` with date presets (7d / 30d / all / custom). No IP, no UA, no user id stored (NF-54 / NF-73; see [`ARCHITECTURE.md`](./ARCHITECTURE.md) §4). The `?gclid=` ad-attribution tag is captured the same way and fed to the Google Ads offline-conversion pipeline.
- 🔲 Global full-text search, bulk operations, abuse review queues — deferred. Tracked in GitHub issues.

### 3.6 Org branding

- ✅ Per-project primary color (hex) — drives the active service-day tab + accent links on every embed surface (CSS custom property `--brand`).
- ✅ Per-org logo upload (PNG / JPEG / WebP / SVG; ≤1 MB) at `/api/orgs/:id/logo`. Public read at `feeds.gtfsx.com/_/orgs/<id>/logo` with edge cache + ETag.
- ✅ Logo renders next to the agency name on the mini-site landing, per-route, per-stop, and system-map embeds.
- 🔲 Custom CSS variables / advanced theming (EM-60). Tracked in GitHub issues.
- 🔲 Per-route display-name override (EM-61). Tracked in GitHub issues.

### 3.7 Billing and subscription plans

Self-serve subscriptions via Stripe — live in production since 2026-05-15
(`worker/billing/*`, `src/components/billing/*`). The `BILLING_ENABLED` gate was
removed on 2026-07-12 (legacy); checkout is always offered.

- ✅ Three tiers — **Free ("Editor") / Agency ("Planner") / Enterprise** (internal plan ids `free` / `agency` / `enterprise`; `agency` was `team` before the pricing-v2 rename, migration 0017; the **Pro tier was retired in pricing v4, 2026-07** — zero subscribers, no migration needed; Stripe env vars stay `STRIPE_PRICE_TEAM_*`):
  - **Free ("Editor")** $0 — editor + up to 3 cloud-saved feeds; **demand-propensity map + system-level cost & coverage summaries** + GeoJSON export + a live demo mini-site preview; no publishing.
  - **Agency ("Planner")** $299/mo · $2,988/yr — the service-planning suite for transit agencies: Premium Feed Management (hosting, publishing, rider-facing embeds + mini-site), the **route-level** planning suite (per-route cost & coverage, Title VI), org workspaces, unlimited feeds, GTFS-Realtime Service Alerts authoring (§4.5), **white-label embeds** (`embed_remove_badge`), custom domain, brand color, phone support; 14-day free trial (card up front).
  - **Enterprise** — custom (talk to sales): multi-agency subscriptions for consultants and state DOTs.
- ✅ Stripe Checkout upgrade flow (`/upgrade`; per-card monthly/annual toggle, defaults to annual).
- ✅ Stripe customer portal for managing / cancelling; 30-day prorated-refund policy.
- ✅ Webhooks (`/api/billing/webhooks/stripe`) sync subscription state → D1 `subscription` + cached `plan`/status on `user` / `organization`.
- ✅ Server-side feature gating via `requireOwnerFeature` (e.g. `managed_publishing`, `draft_links`, `analysis_basic`, `analysis_title_vi`, `org_workspace`, `org_logo`, `brand_color`, `service_alerts`, `embed_remove_badge`); `PaywallOverlay` is the client surface. `service_alerts` + `phone_support` → Agency + Enterprise.
- ✅ **Pricing v3 (2026-06) feature reallocation** (code-config, no migration): demand dots (`analysis_propensity`) are free for everyone incl. anonymous; the cost & coverage panels split into a free **system-level** summary and a paywalled **route-level** breakdown (`analysis_basic`, Agency+); the free embed paywall links to the demo mini-site; `phone_support` → Agency+.
- ✅ **Pricing v4 (2026-07): Pro retired** (code-config, no migration — zero Pro subscribers). Everything formerly Pro+ (`managed_publishing`, `draft_links`, `mobility_db_submit`, `embeds`, `snapshot_history`, `brand_color`) is now Agency+; `geojson_export` dropped to **all plans incl. free**. Display rename shipped alongside: free → "Editor", agency → "Planner", enterprise → "Enterprise".
- ✅ Org workspaces are an Agency+ feature — Free users are routed to `/pricing` rather than creating empty orgs.
- ✅ Plan catalog served from the worker, with an in-SPA fallback for the public `/pricing` page; done-for-you services (fix / build a feed) advertised there via a scoping-call booking + email (not a billed product).
- Pricing history (the Team→Agency rename + the v2 price change) is preserved in the archived `PRICING_RESTRUCTURE.md`.

---

## 4. Feed publication and distribution

Architecture and API surface are in [`ARCHITECTURE.md`](./ARCHITECTURE.md) (§3 API, §1 module map).

### 4.1 Canonical publication

- ✅ "Publish" promotes a saved snapshot to the canonical URL `feeds.gtfsx.com/<slug>/gtfs.zip`. Stable across republishes; only the bytes change.
- ✅ Validation gate: errors block publish; warnings allowed (configurable per-publish).
- ✅ Cache headers tuned for GTFS ingestors: `public, max-age=3600, s-maxage=3600`, version-id ETag, `Last-Modified`, 304 support, atomic R2 → D1 pointer flip.
- ✅ Sidecar `feeds.*/<slug>/feed_info.json` with title, description, effective dates, version id, contact, distribution targets, registered RT feeds — plus an **`agencies[]`** array (`agency_id` / `agency_name` / `external_id` per agency, each key omitted when unset, so a consumer sees "absent" rather than an explicit null) and `license_spdx_identifier` when the publisher declared one. `agencies[]` is projected out of the published snapshot state, not out of D1: the feed is the source of truth for its own agencies. It replaces the earlier single top-level `ntd_id`, which could not describe a multi-agency feed.
- ✅ **Feed identity at publish** — the Publish panel carries **one** optional field projected onto the publication: the feed's **license** (SPDX short id; `CC0-1.0` / `CC-BY-4.0` / `ODbL-1.0` / unset — we never guess one), stored in editor feed state (`licenseSpdx`) and projected onto `feed_project.license_spdx` (migration `0024_feed_license`). There is deliberately **no** project-level NTD ID: an agency's NTD ID is `Agency.external_id` (§1.8), which lives inside the feed and therefore already rides along in the snapshotted state that publication reads. **NTD IDs are strings with significant leading zeros** — carried as text end to end and never `Number()`-coerced.
- ✅ Unpublish — pointer cleared, canonical URL returns `410 Gone`. Republish restores.
- ✅ Publication history view + rollback ("publish this old snapshot again").
- ✅ Published-feed editor deep-link — the current-publication section surfaces a copyable **"Copy editor link"** (plus an "Open in editor" link) for `import?url=<canonical gtfs.zip>`, so the published feed opens straight in the editor (no account needed), mirroring the draft-link share UX. The import proxy short-circuits same-zone canonical URLs by reading the published ZIP from R2 directly (Cloudflare refuses worker→own-zone fetches with a 522, which previously broke this deep-link).
- ✅ Per-snapshot state stored as gzipped JSON (R2) plus a rendered ZIP (also R2); two immutable blobs per snapshot.
- ✅ Scheduled publish (BE-77) — in the Publish panel, choose "Schedule for later" and pick a date/time; the selected snapshot publishes automatically at the next check after that time (a `*/15` cron, so within ~15 min). One pending schedule per feed; re-scheduling replaces it and "Cancel" clears it. The rendered GTFS ZIP is captured when you schedule (so the cron can publish without the editor open); a failure (e.g. plan downgraded before the time arrives) is surfaced in the panel.

### 4.2 Draft links

- ✅ "Create draft link" (in the Share &amp; Publish → "Share for review" section) generates `feeds.*/<slug>/draft/<token>.zip` with an unguessable 256-bit token (hashed at rest). 30-day expiry, revocable; also surfaces an `import?url=` open-in-editor link sharing the same revocation.
- ✅ `X-Robots-Tag: noindex`; feeds-origin `robots.txt` disallows `/draft/`.
- ✅ Each draft URL points to a specific `feed_snapshot` so the bytes don't change once a link is shared.

### 4.3 Catalog submissions and distribution metadata

- ✅ One-time opt-in per project at first publish: register with the Mobility Database (real API call against the existing refresh token).
- 🟡 transit.land submission — wired through the same `CatalogClient` interface but stubbed (status=`pending`, manual-review marker). Pre-RTAP follow-up. Tracked in GitHub issues.
- ✅ Externally-hosted GTFS-RT feed URLs can be registered per project (vehicle_positions / trip_updates / alerts). These are metadata only — we forward them in `feed_info.json` but don't proxy them. (Distinct from the alerts feed we *generate* in §4.5.)
- ✅ ID-stability check on publish: warns when a publish would drop or rename a `trip_id` / `stop_id` / `route_id` / `agency_id` referenced by a registered *external* RT feed (409 `rt_breakage`, acknowledged with `ignoreRtBreakage`). (Our own managed Service Alerts feed self-renders and is excluded.)
- ✅ **`agency_id` churn warning on publish** — 409 `agency_id_churn`, acknowledged with `ignoreAgencyChurn` ("Publish anyway"). Fires when a publish would remove or rename an `agency_id` present in the currently-published feed. Unlike `rt_breakage` this applies to **every** project, RT or not: FTA's enhanced P-50 form crosswalks a published feed to its NTD ID on `agency_id`, so churning one silently breaks the NTD crosswalk (and any consumer keyed on it). Both gates read the same published-vs-new diff, computed at most once per publish; both are skipped on a first publish and on a re-publish of the already-published snapshot.
- ✅ **NTD ID + the FTA P-50 crosswalk.** FTA proposed forcing `agency_id` == NTD ID, withdrew it (July 2025), and now crosswalks feeds → NTD IDs itself via the enhanced **P-50** (Transit Agency Identification) form, which collects the feed's stable URL plus the `agency_id`/`agency_name` pairs inside it. Each agency carries its own NTD ID (`Agency.external_id`, §1.8), so it rides through publication inside the feed and the crosswalk survives. The **NTD / P-50 helper panel** (`NtdP50Panel.tsx`, shown once a feed is published) lays out exactly the fields the form asks for: the canonical feed URL, and a row per agency with its `agency_id`, `agency_name`, and its **own** `external_id`, each copy-ready, with a hint on any agency that has none. Read entirely from existing state; no new endpoint. The old "the NTD ID identifies the reporting agency for the feed as a whole, per-agency IDs aren't modeled" caveat is **gone** — they are modeled.
- ✅ **DMFR document per published feed** — `GET feeds.*/<slug>/dmfr.json`, a [Distributed Mobility Feed Registry](https://dmfr.transit.land/) v0.5.1 document (schema vendored + asserted against in `worker/__tests__/`). Lets a publisher hand **one URL** to Transitland / the Mobility Database and land in their pipelines with the NTD crosswalk already attached, on `operators[].tags.us_ntd_id` (the tag transitland-atlas uses). Emits **one operator per agency**, each with its own `tags.us_ntd_id` and its own `associated_feeds[].gtfs_agency_id` tying it to that agency inside the feed — so a feed carrying several NTD reporters crosswalks unambiguously. Also carries the feed's SPDX license and a companion `gtfs-rt` entry (one `urls` field per registered RT message type; omitted when the project has no RT feeds). Judgment calls, since the schema is stricter than our data model: the required `operator.onestop_id` is **derived** following Transitland's documented `o-<geohash>-<name>` convention (rather than emitting a placeholder) from the feed's stop centroid — the only geography we have, so co-located agencies share the geohash and are distinguished by the name component. When the feed has no usable stop coordinates the optional `operators` container is omitted entirely, and the NTD ID falls back to the feed's free-form `tags` **only when exactly one agency declares an `external_id`** (a feed-level tag cannot say which agency it belongs to; with two or more we omit rather than assert an ambiguous crosswalk).
- ✅ Distribution checklist UI: Mobility DB (auto), transit.land (auto/stub), Google Transit Partners + Apple Maps Transit + Transit app (external links + manual mark-done).
- ✅ **Feed Health dashboard** (`public/feed-health/`) surfaces each agency's **NTD ID + Mobility Database feed ID** in the state agency drill-down — the two identifiers FTA's P-50 form asks for.
- ✅ **GTFS-Realtime Service Alerts generation is in scope** (§4.5). Trip Updates and Vehicle Positions remain out of scope — they require live AVL ingestion.

### 4.4 Embeddable maps and schedules

Live in production.

Architecture: server-rendered HTML on the FEEDS origin (Hono `html` template), edge-cached, version-id ETag. Same renderer powers the public mini-site landing, the iframe embeds, and shared social-card meta. Mapbox GL JS via CDN; the SPA's existing public publishable token is also bound to the Worker as `MAPBOX_TOKEN`.

| Surface | URL | Status |
|---|---|---|
| Mini-site landing | `feeds.*/<slug>/` | ✅ — agency name + contact, system map, route list, today's-service banner, `frame-ancestors 'none'`, indexable |
| Per-route embed | `feeds.*/<slug>/embed/route/<route_id>` | ✅ — route map + schedule table with seasonal/day-pattern tabs, defaults to today's pattern; "← All routes" link back to the system map |
| Per-stop embed | `feeds.*/<slug>/embed/stop/<stop_id>` | ✅ — chronological "departures today" + map + routes serving the stop; "← All routes" link back to the system map |
| System-map embed | `feeds.*/<slug>/embed/system-map` | ✅ — all routes coloured, clickable stop dots, route list |
| Sectioned route embed | `feeds.*/<slug>/embed/route/<route_id>?view=map\|schedule` | ✅ — map-only / schedule-only variants of the per-route page; powers the standalone web components |
| Widgets loader | `feeds.*/widgets.js` | ✅ — declarative web-component loader registering `<gtfs-system-map>` / `<gtfs-route-map>` / `<gtfs-schedule>` / `<gtfs-stop>`, each wrapping the matching embed page in a sandboxed iframe |
| Demo agency page | `/embed-demo/` (editor origin) | ✅ — fake "Sunny Valley Transit" page demonstrating iframe usage |

Cross-cutting embed features:

- ✅ Today's-service banner ("Today is Friday · Weekday schedule in effect" / "No service today") computed in agency timezone.
- ✅ Feed-expiry warning when within 14 days of `feed_end_date` (yellow) or already past (red).
- ✅ Service-day tabs split by both day pattern AND date range — feeds with seasonal services (e.g., summer / fall / spring weekday variants) get separate tabs disambiguated by date.
- ✅ Per-org brand logo + per-project brand color applied via CSS custom properties.
- ✅ Open Graph + Twitter card meta on every embed page.
- ✅ Auto-generated route-map thumbnail (whole-system map, routes in `route_color`) via the Mapbox Static Images API, cached in R2 (migration 0016); used as the `og:image` on the mini-site and as the card image in the feeds list. A styled fallback (gray bus outline + GTFS·X wordmark) renders before the thumbnail exists.
- ✅ Mobile responsive layout (220px map on phones, sticky stop-name column, narrower tabs).
- ✅ Editor "Embed" bottom-tab on a published feed: copy-pasteable iframe snippets per route + system map; live brand-color picker; web-component (widgets.js) tag snippets.
- ✅ `widgets.js` declarative web-component loader (`<gtfs-system-map>`, `<gtfs-route-map>`, `<gtfs-schedule>`, `<gtfs-stop>`) — one origin-level script; each tag wraps the matching embed page in a sandboxed iframe (read-only, snapshot-scoped, badge gate inherited). Map/schedule tags use the new `?view=` sectioned route embed.
- 🔲 Headless JSON API at `feeds.*/<slug>/api/*`.
- 🔲 Localization — UI strings in English only; Spanish queued (Streamline already publishes Spanish PDFs, so demand exists). Per-route display-name overrides + `translations.txt` consumption deferred to the same phase.
- 🔲 Per-stop / per-route impression counters (`embed_view_count`) and the agency-facing usage view.
- 🔲 GTFS-RT integration on stop pages (live arrival times when an RT feed is registered) — stretch.

(The Phase 7 embed backlog above is tracked in GitHub issues.)
- 🚫 Custom domains for published feeds. Agencies can `301` from their own domain if needed; we don't issue per-tenant certs.

### 4.5 GTFS-Realtime Service Alerts (Agency+)

Authoring of GTFS-Realtime **Service Alerts** in a new "Service Alerts" workspace section, served as a spec-compliant `FeedMessage`. Engineering detail in [`ARCHITECTURE.md`](./ARCHITECTURE.md) (BE-90..93).

- ✅ Alerts are **project-scoped** and **decoupled from publish** — posting or expiring an alert takes effect on the live feed without republishing the schedule. Each alert is a `service_alert` D1 row (migration `0018`), not an R2 blob; the protobuf is rendered on demand.
- ✅ CRUD + activate/deactivate + live preview under `/api/projects/:id/alerts`, gated by project `editor` access **and** the `service_alerts` feature (Agency+). Cause / Effect / Severity, multiple active windows, and affected-entity pickers (routes / stops / whole agency, optional direction) populated from the live editor.
- ✅ Served **public** at `feeds.gtfsx.com/<slug>/alerts.pb` (`application/x-protobuf`) and `/alerts.json`, `FeedMessage` v2.0 / FULL_DATASET, only currently-active alerts (status + `active_period`), `Cache-Control: public, max-age=30`. Authoring is gated; the served feeds are open (consumers are trip planners).
- ✅ Validation: ≥1 informed entity, non-empty header, `end > start` on windows; **warns** (doesn't block) when a referenced `route_id`/`stop_id` isn't in the published feed.
- ✅ **RT coexistence (Option A):** authoring auto-wires a managed `project_rt_feed` row (`kind='alerts'`, `managed=1`) pointing at our `alerts.pb` so `feed_info.json` advertises it; never two alerts feeds (if an external one exists the UI forces a choice); the row is removed when all alerts are deleted.
- ✅ Single language for v1 (`TranslatedString` with one translation). 🔲 Multi-language alert text — backlog (BE-93).
- 🚫 Trip Updates / Vehicle Positions / push notifications / auto-generated alerts — out of scope.

---

## 5. Community forum

A public Q&A / discussion forum at `/community`, server-rendered for SEO. Shipped
(`worker/forum/*`, `src/components/community/*`; migrations 0008 / 0010 / 0011).

- ✅ Categories (announcements, getting-started, editor, import-export, embeds-publishing, feature-requests, bugs, general), threads, and markdown posts.
- ✅ Post upvotes (one per user, toggleable); "mark solved" on a thread's answer.
- ✅ Thread subscriptions (auto on create/reply, manual toggle) with Resend email notifications; admin alert on new threads.
- ✅ Per-user forum profile — forum display name independent of the account name, gravatar opt-out, email preferences, ban support.
- ✅ Image attachments uploaded to R2 (`gtfs-builder-forum-images`); markdown rendering.
- ✅ FTS5 full-text search (`forum_search`).
- ✅ Server-side rendering with Open Graph + canonical URLs + sitemap (indexable).
- ✅ Moderation (staff): edit / soft-delete / lock / pin / move / ban.

---

## Cross-cutting

### Mapping platform — Mapbox GL JS

The original platform analysis is preserved here because the choice still drives most map-related decisions:

| Consideration | Mapbox GL JS | Google Maps JS API | Leaflet + OSM |
|---|---|---|---|
| Drawing/editing tools | Excellent — `mapbox-gl-draw` supports points, lines, polygons with snapping, vertex editing, drag | Drawing library exists but limited vertex editing, no snapping | `leaflet-draw` works but less polished |
| Custom map styling | Full control — Studio editor, custom tilesets | Limited via JSON; fewer options | Tile-provider dependent |
| Performance (large shapes) | WebGL-rendered, handles thousands of shape points | Good but heavier DOM usage | Canvas mode helps but slower |
| Polygon support (Flex zones) | Native, with editing handles | Basic | Basic |
| Pricing | 50K free map loads/mo, then $0.60/1K | $7/1K loads after $200 credit | Free, tile-quality / hosting tradeoffs |
| Developer experience | Excellent docs, TypeScript, `react-map-gl` | Mature but more boilerplate | Very flexible but more DIY |

We use `react-map-gl` + `@mapbox/mapbox-gl-draw` in the editor and Mapbox GL JS via CDN in the embed renderer. The Map Matching API powers snap-to-road; the Static Images API renders feed thumbnails. Cost stays well under the free tier at current usage.

### Infrastructure

Single Cloudflare account; everything runs as a single Worker with static-asset binding and multiple custom domains.

```
www.gtfsx.com          → editor SPA + /api + /auth + /_demand-tiles
gtfsx.com (apex)       → same as www
feeds.gtfsx.com        → public feed distribution + embed renderer
                               + /_/orgs/<id>/logo public read

staging.gtfsx.com      → staging editor
staging-feeds.gtfsx.com → staging feeds origin
```

| Concern | Service |
|---|---|
| Compute | Cloudflare Worker (single `gtfs-builder` deploy + `gtfs-builder-staging`) |
| Relational metadata (users, orgs, projects, snapshots, publications, subscriptions, forum, audit, events) | D1 |
| Rate-limit counters, KV cache | KV |
| Tiles + feed blobs | R2 (`gtfs-builder-tiles` for PMTiles; `gtfs-builder-feeds` / `gtfs-builder-feeds-staging` for working states, snapshots, ZIPs, org logos, feed thumbnails; `gtfs-builder-forum-images` for forum attachments) |
| Transactional email | Resend |
| Bot mitigation | Cloudflare Turnstile (signup) |
| Web analytics | Cloudflare Web Analytics (cookieless, zone-level) |

Frontend stack: React 18 + TypeScript, Vite, Zustand (Immer middleware) for state, Radix UI + Tailwind, Dexie for IndexedDB, JSZip + PapaParse for GTFS, `@turf/turf` for geometry, `@cloudflare/vitest-pool-workers` for the worker test harness.

### Design direction

- **Mood**: warm, approachable, slightly playful — a planning tool, not enterprise GIS.
- **Palette**: warm neutrals (cream, sand, soft brown) with vibrant accent colours for routes; coral primary; teal save indicator.
- **Typography**: rounded sans-serif headings, clean body text.
- **Map style**: Mapbox `light-v11` baseline, route shapes coloured per `route_color`, stop dots as white-with-dark-border.
- **Empty states**: illustrated and encouraging.
- **Editor layout** (since 2026-05): **two-rail shell** — a responsive **left rail** for navigation between sections (continuously resizable 40–260 px via a drag handle; renders 3 variants by width: icon-only / icons + labels / full rows + accordion section caps; responsive default per viewport), centre map, **right rail** at 460 px hosting all configuration panels (opens on section selection, collapses to a thin reopen strip during shape-edit, `Cmd/Ctrl + /` toggle), and a collapsible bottom panel (timetable, validation, snapshots, publish, embed, activity). Route detail is master-detail with a breadcrumb, swatch + title row, Duplicate / Delete header actions, and Details / Stops / Trips / Shapes / Costs tabs that focus the map appropriately. Three-tier text hierarchy across all panels — section H2 (rail header) / sub-section H3 (`<RailSubHeading>`) / uppercase form-field eyebrow.
- **Topbar**: shared `<AppBrand>` + `<UserMenu>` across every page (editor, feeds, account, orgs, admin). The right-edge avatar slot is consistent across signed-out (outlined person icon) and signed-in (coral initials avatar) states, divided from the editor actions. Tagline hides below 1100 px viewport, save-status text below 900 px. Help moved to a floating "? HELP" pill at the bottom-left of the map area.

### Non-functional requirements

- **Performance**: 60 fps map interaction; feeds with 500+ stops, 50+ routes; import/export of 10 MB feeds within 10 s; autosave (local) within 1 s.
- **Usability**: no GTFS expertise required; warm visual design; desktop-primary, tablet-friendly; keyboard shortcuts for common map operations.
- **Data integrity**: referential integrity enforced (e.g., orphaned reference auto-fix surfaced in the export dialog); IDs auto-generated and overridable; IndexedDB persistence keeps anonymous editor work safe across crashes; explicit Save button for server-backed feeds with `beforeunload` guard on unsaved changes.
- **Accessibility**: WCAG 2.1 AA target for non-map UI; embed pages audited with axe-core; schedule tables use `<th scope="row">` / `<th scope="col">` for screen-reader compatibility.
- **Privacy**: PII limited to email, display name, IP + UA on active sessions, and feed contents; no third-party analytics; no marketing tracking.
- **Auditability**: every state-changing backend action writes an `audit_event` (login, publish, delete, member changes, admin impersonation, transfers, …).

### User workflow

The editor guides users through this default path, though every section is reachable at any time via the left nav rail:

```
1. Agency setup           →  Who operates this transit?
2. Calendars + holidays   →  When does service run?
3. Routes & shapes        →  What paths do vehicles take? (alignments first)
4. Stops                  →  Pick a route, place stops along it (snap-to-route default)
5. Fares                  →  How much does it cost to ride? (prompted if missing)
6. Timetables             →  What are the trip times?
7. Flex zones (optional)  →  Demand-responsive areas + booking rules
8. Analysis               →  Demand dots, coverage, Title VI, stop analysis, cost
9. Validate & publish     →  Errors → fix; warnings → optional. Publish to a stable URL.
10. Embed                 →  Copy iframe snippets into the agency website.
```

On first load: nothing is selected, the right rail is closed, and the map fills the available width. Clicking any left-nav tile opens the matching configuration panel in the right rail. The bottom panel surfaces analytical views (timetable, validation, etc.) and is collapsible — it ducks under the left rail only and spans the full width across map + right rail.

---

## Companion documents

This file is the product-feature map. Engineering depth lives in one place:

| Doc | Scope |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | The single engineering reference — system architecture, data model, full API surface, security / privacy NFRs (preserves the `BE-*` / `NF-*` anchors), live environment state, git + deploy workflow, provisioning + operator runbooks, and the demand-dot regen + Google Ads OCI appendices. |
| [`brand-kit/`](./brand-kit/) | Brand assets — logos, palette, fonts, guidelines. |
| GitHub issues | The backlog of 🔲 planned features (Fares-v2 authoring UI, ferry support, `frequencies`/`pathways`, scheduled publish, embed Phase 7, argon2id, large-feed perf, etc.). |

Superseded specs and historical records — the original backend / embeds / forum /
freemium specs, the pricing-restructure and domain-migration logs, the demand-dot
build plan, and the marketing plans — are preserved under `docs/archive/`
(gitignored; local reference only).
