# Pipe fresh-file resume handshake

A resumable sender waits up to 500 ms per file for a `resume` frame. Previously, the receiver only returned that frame when preserving matching partial data, so fresh transfers paid the full timeout. Fresh resumable metadata now receives the existing `resume` frame with offset zero. The matching-partial branch, non-resumable metadata behavior, legacy-receiver fallback timeout, checksums and final acknowledgement logic are unchanged.

## Protocol verification

Run from the repository root with Node.js 24:

```sh
node --test scripts/pipe-resume-latency.test.mjs
```

The test reads the actual application functions and compares against baseline commit `96ff46795f2e396bd51d8f20e80a93d079d560d4`. That commit must be present in the local Git history. `PIPE_BASELINE_REF` can select another compatible baseline. No npm dependencies or network are needed for this test.

Coverage includes four baseline/modified sender-receiver combinations, single and multiple files, byte equality, empty files, matching partial resume, different-file reset, non-resumable metadata, cancellation during resume negotiation and delayed final acknowledgement. Sender and final-ACK functions are asserted unchanged against the baseline.

A five-sample benchmark alternates baseline and patched receivers using 4 KiB synthetic files and asynchronous in-memory delivery scheduled at 1 ms per direction. Completion timing includes the final acknowledgement. Local Node.js v24.19.0 medians:

| Files | Baseline | Patched |
| --- | ---: | ---: |
| 1 | 504.1 ms | 5.5 ms |
| 5 | 2509.3 ms | 15.4 ms |

These are simulated-transport protocol measurements. They show removal of the intentional per-file wait; they are **not** real-browser, LAN, WAN, throughput, or user-perceived end-to-end measurements. Session creation, signaling and rendering are not modeled. Set `PIPE_BENCH_OUTPUT` to save raw samples as JSON. All 10 tests passed locally; syntax checks and `git diff --check` also passed. The full repository test suite was not run.

## Browser verification still required

The local Chromium launch was blocked by the host's process-singleton `socket()` restriction (`Operation not permitted`), including after execution escalation. Browser sandbox and TLS checks were not disabled. Actual browser transfers, screenshots and visual review have therefore **not** been completed.

A syntax-checked, runtime-unverified companion harness is provided:

```sh
CHROMIUM_PATH=/usr/bin/chromium PIPE_BROWSER_OUTPUT=./pipe-browser-results node scripts/pipe-resume-browser.mjs
```

It requires the repository's Playwright dependency. `PIPE_PLAYWRIGHT_MODULE` can instead point to an installed Playwright module using a file URL. The harness serves local baseline/patched pages, uses loopback-only signaling and host-only ICE, blocks outside HTTP requests and WebSockets, and transfers synthetic files through actual UI controls. It checks bytes and records post-ACK completion, then captures screenshots for subsequent human inspection. Unrelated CDN QR rendering is stubbed in the harness only.

The companion covers baseline/patched receivers with the patched sender, one file, five files and a zero-byte file. Cancellation, partial resume and all old/new combinations remain protocol-only coverage until real-browser validation is expanded and run. No production relay or production telemetry is used for these tests.

The `CI - Pipe Resume Protocol` pull-request workflow runs syntax checks and the protocol tests for affected Pipe source/test changes. It uses a read-only token, does not persist checkout credentials, fetches baseline history and performs no deployment. It does not run the browser harness.
