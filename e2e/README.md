# T05 browser checks

Run `npm run test:e2e` from `frontend`. Both mock and real-mode projects run by default; `E2E_REAL=0 npm run test:e2e` runs only mock coverage. The installed Playwright version is pinned in the package lock. Tests use `/usr/bin/google-chrome` with GPU acceleration disabled and temporary Playwright browser contexts, without browser downloads or personal profiles.

Playwright owns Vite mock port 5173, real-mode Vite port 5174, and the contract-only ASGI service on port 18000. Existing servers are never reused; occupied ports cause a failure. The ASGI command clears `PYTHONPATH` and `PYTHONHOME` and starts only the contract application. It does not start IsaacSim or a worker. Playwright stops its servers after the run.

All actions use visible controls. The read-only diagnostics supply observations only. The oracle reads the selected snapshot and actual canvas pixels in one synchronous evaluation, independently decodes all 32 capture-ID bits and 32 CRC bits, checks synthetic source values, and samples the rendered progress bar. An independent canvas rasterizes expected time, source-angle, and six joint-value labels for pixel comparison with the actual displayed text. It does not import the production stamp, renderer, runtime, or store. Multiple unique capture IDs are sampled in each replay scenario; paused captures must keep advancing while time and joint values remain constant.

The suite covers lifecycle controls, failed upload, absent log, missing-channel provenance, worker recovery, 650 ms video/data delay, WebSocket reconnect, delayed-resource teardown, and real mode's explicit backend 503 without MSW or synthetic fallback. It checks T05 frontend behavior only; it does not validate real H.264, WHEP, IsaacSim, GPU rendering, or final product acceptance.

Each test writes `observations.json` and `final-page.png` under `output/test-results`; failures also retain Playwright traces and screenshots. Browser HTTP requests outside loopback are blocked and reported as failures. No HTTP or WebSocket success responses are fabricated by the test suite: mock traffic is handled by the application's native MSW installation.
