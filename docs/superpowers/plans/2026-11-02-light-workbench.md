# Light Replay Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the user-approved light B integrated workbench, including drawers and interaction states, without changing any existing external API.

**Architecture:** Keep image, joint/chassis readings, actual time/progress and history cursor in one atomically painted canvas. Reorganize DOM controls around that canvas using the existing Vue/Pinia and Naive UI stack. Retain imported metadata by session/log identity so a new candidate never replaces the active log's details.

**Tech Stack:** Existing Vue 3.5.44, Pinia 3.0.4, Naive UI 2.45.3, ECharts 5.6.0, TypeScript and Playwright; no new runtime dependencies.

**Spec:** `docs/design/light-workbench-spec.txt`; reviewed artwork in adjacent `../designs/replay-workbench-v2/screens/`. Latest primary reference: `01-workbench.png`.

## Global Constraints

- Existing REST, WS, IPC schemas, units, transport and synchronization identities remain unchanged. Do not edit generated API files, backend implementation, robot assets, or raw logs.
- Render the same verified frame as one visual transaction; delayed/failed streams jointly hold the last complete frame. Accepted/applied/rendered are not presented.
- Light neutral UI, no persistent left sidebar. Top log toolbar and detail/import drawers; upper left robot and upper right joints; four stacked curves; playback controls; stage/event tabs beneath.
- Joint groups display left arm/gripper 9 and right arm/gripper 9 above torso 4 and chassis 6. All 28 canonical indices and provenance remain intact. Missing values are em dashes; derived limits are unassessed.
- Support CSV/JSON/.b041 only, mapping before choosing file, explicit activation, no auto-play. No new log-library, direct Parquet/MCAP, download, camera or robot-control capabilities.
- Source stage/event semantics and nullable health remain truthful. CPU/RAM/GPU unavailable values are not zero. No new backend log-details endpoint.
- Work in `feature/light-replay-workbench` from v1.0.0 main in the existing frontend checkout, keeping the adjacent backend/SDK paths intact. No merge, release or main push during implementation.
- New file names are ASCII. Local evidence goes under ignored `output/light-workbench/`.

## Review Focus

1. Upload candidate B fails or remains unactivated while active A still plays: details and provenance must remain A's. Task 1 regression.
2. Close/recreate while upload completes late: no old session's metadata can populate the new session. Task 1 regression.
3. Seek or channel changes while image/data are delayed: actual readings/cursor must not follow target previews. Task 2 pixel checks and Task 3 browser test.
4. Dialogs/keyboard Enter while WS is disconnected or creation/close is busy: same enablement as buttons. Task 3 browser checks.
5. Missing/derived channels, null event times and long metadata: no fabricated valid values or inaccessible hidden actions. Tasks 2/3 semantic and browser checks.

## Task 1: Preserve imported details by identity

**Files:** modify `src/stores/playback.ts`, `src/app/controller.ts`; add `tests/stores/logDetails.test.ts`; extend `tests/stores/controller.test.ts` as needed.
**Interfaces:** keep `playback.uploaded` as current candidate for compatibility. Export `ImportedLogDetails` with `sessionId`, `result: UploadResult`, `fileName`, `fileSize`, `importedAt`. Add `beginUpload(sid: string): void`, `recordUpload(sid: string, result: UploadResult, file: {name:string;size:number}, importedAt?: number): void`, `getLogDetails(sid: string, lid: string | null | undefined): ImportedLogDetails | null`. Reset clears the cache. Existing controller public methods/signatures stay unchanged.

- [ ] Write regressions using real Pinia store/controller behavior: A active then B candidate, failed B preserving A, mismatched sid lookup null, caller result mutation does not change saved snapshot, close/recreate late completion ignored.
- [ ] Run the focused tests and record the intended failing assertions.
- [ ] Implement identity cache and hook existing upload lifecycle. Preserve active details when clearing a new candidate; do not fetch nonexistent GET log details or hold File/Blob objects.
- [ ] Bound retained details (at most 8), preserve active and current candidate on eviction, and retain explicit missing-cache fallback. Verify new-session reset and ordinary playback update do not cross-contaminate metadata.
- [ ] Run focused and full unit suites; commit only owned files and report observable API usage unchanged.

## Task 2: Light atomic presentation and independent pixel checks

**Files:** modify `src/media/renderer.ts`, `src/media/historyChart.ts`; optionally add `src/media/presentationLayout.ts`; update independent pixel geometry in `e2e/oracle.ts`, `e2e/workbench.spec.ts`, `e2e/real-replay.spec.ts`, `e2e/resilience-video.ts`, `e2e/resilience-recording.spec.ts` and affected pure tests. Do not edit App, components, controller, generated contracts or source-frame stamp/decoder transport.
**Interfaces:** keep existing `drawPresentation`, `drawEmptyPresentation`, `makeMockFrame`, `PresentationOptions` compatible. Export existing presentation width/height/image/history constants with new geometry; optional pure layout helper for group positions. Preserve source bitmap dimensions/marker identity. Renderer targets 1600x800: image x16,y48,width768,height432; 2x2 joint groups right, arms first; chassis/time in remaining top strip; history x16,y568,width1568,height216. If fine geometry must change for legibility, document final values and keep independent expected pixels separate from production helpers. Parent UI reads only exported canvas dimensions, not hard-coded coordinates.

- [ ] Add a meaningful rendering regression that catches omitted/wrong-group joints, unassessed derived limit labels, missing values and old-log history composition; fail it before implementation.
- [ ] Recompose presentation into light surfaces with all current values atomically from the frozen snapshot. Keep whole-canvas commit/identity verification intact, raw mock/real source image semantics unchanged.
- [ ] Use readable joint rows (>=16 logical px), group headings and light independent-axis history. Allow collapsed groups without losing canonical indices. Do not independently animate cursor/numbers.
- [ ] Adapt existing pixel oracles independently, retaining identity+CRC, source-value text/chassis, progress, geometry motion, shared-cursor assertions and tolerances; do not disable checks or import production rasterization into expected data.
- [ ] Run affected unit suites; coordinate final browser runs after Task 3. Commit owned code/tests and document geometry, not proof-by-source-text tests.

## Task 3: Workbench shell and complete interactions

**Files:** modify `src/App.vue`, `src/style.css`, `src/components/UploadPanel.vue`, `HistoryControls.vue`, `AnnotationPanel.vue`, `TimelineControl.vue`; add focused components for layer/drawer, log details, precise seek, channel selection and health as needed. Add browser coverage `e2e/light-workbench.spec.ts`; adapt existing UI test navigation without weakening semantic assertions.
**Interfaces:** consume Task 1 `getLogDetails(sid,lid)`, retain existing controller methods, Pinia states and component test IDs when practical; consume Task 2 canvas dimensions. No new external API or dependency.

- [ ] Write browser regression for opening import, mapping before selection, parsed candidate/active separation, re-open pending candidate, readonly active details, channel draft cancellation, precise seek guard and close cancellation; run RED against the prior UI.
- [ ] Build the approved no-sidebar light shell: top environment/log toolbar, complete synchronized canvas, curve selector, nearby transport, stage/limit/activity tabs and independent health footer.
- [ ] Import drawer retains inputs on close; upload has real waiting/error/parsed states and explicit activation. Details drawer is bound to requested sid/log ID, with truthful missing-cache state, diagnostics and immutable mapping snapshot.
- [ ] Implement channel chooser (0–4, cancel/apply), precise seconds/frame dialog (finite/whole validation, same button/Enter gate), close confirmation (cancel is a no-op), and health details with nullable fields. Use framework focus-trap/return-focus where available.
- [ ] Preserve stage/source/reference/null-time semantics, pagination and all three event sources. Keep Mock-only inputs visibly separate; maintain group folding and clear source/limit legends.
- [ ] Use readable desktop layout, keyboard access and reduced-motion-aware layers. Inspect wide/narrow screenshots and fix actual clipping without shrinking the whole screen to illegible type.
- [ ] Run the focused browser tests, full unit/build and existing 14 browser checks; commit owned UI/test files.

## Task 4: Integration, real replay validation and review

**Files:** update documentation/evidence under `docs/validation/` and README; only adjust implementation files for concrete failures. Backend source remains unchanged.

- [ ] Confirm no backend or generated contract diff, run contract export consistency and final frontend unit/typecheck/build/Chrome suites.
- [ ] Exercise real existing SDK/worker/UI with the existing synthetic replay launcher, in a new owned evidence directory. Do not stop user's services; use only owned validation resources. If performance requires the documented balanced mode, temporarily use it and restore the prior mode.
- [ ] Verify actual image/data/curve pairing, controls, worker fault/new-session zero, uploaded details, final cleanup and screenshots. Preserve failed evidence; do not weaken >=15fps/<2s or source-value checks.
- [ ] Obtain independent scoped reviews for completed tasks and one whole-branch review; fix substantive findings and record any remaining limits.
- [ ] Commit final documentation with commands and results. Leave tested feature branch ready for user review, without merging or releasing.
