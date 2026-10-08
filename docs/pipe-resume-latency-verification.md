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

## Real-browser verification

The dot workspace cannot launch Chromium because of a host process-singleton socket restriction. Browser verification therefore runs in GitHub's Ubuntu runner using its official Google Chrome installation and Playwright 1.60.0. The harness checks `chrome://sandbox` for an adequately sandboxed browser; namespaces and Seccomp-BPF are enabled, and TLS validation is unchanged.

```sh
CHROMIUM_PATH=/usr/bin/google-chrome PIPE_BROWSER_OUTPUT=./pipe-browser-results node scripts/pipe-resume-browser.mjs
```

The harness requires Playwright (`PIPE_PLAYWRIGHT_MODULE` may select its installed module by file URL). It serves the actual app pages, uses real Send/Receive controls and RTCDataChannels, loopback-only signaling and host-only ICE, blocks external HTTP/WebSocket requests, and never uses the production relay or telemetry. Unrelated CDN QR rendering is stubbed. Google Drive sign-in and nearby-device discovery are not exercised.

Five alternating baseline/patched receiver samples with identical sender code, Chrome 154.0.8037.97 and 4 KiB files produced these observed medians:

| Files | Baseline click-to-confirmation | Patched click-to-confirmation | Baseline after metadata | Patched after metadata |
| --- | ---: | ---: | ---: | ---: |
| 1 | 566 ms | 67 ms | 507 ms | 8.5 ms |
| 5 | 2570 ms | 77 ms | 2512 ms | 19.1 ms |

These are localhost UI/WebRTC latency measurements, **not** WAN throughput claims. Prewarming remains enabled. Confirmation is the later of sender completion and observed final receiver acknowledgement. The harness records per-file waits and validates each received file byte-for-byte. Each case has its own channel; for one file the receiver sends an ACK for `done` and another for `all-done`, while multi-file cases send the final ACK only. The harness waits for the corresponding ACK count before taking the final timestamp.

The CI artifacts contain raw measurements, sandbox evidence, desktop screenshots and a 390 px mobile-emulated mixed-file case. Coverage includes single/multiple/empty files, baseline/modified sender-receiver combinations, cancellation of a long legacy-receiver queue, and a fresh transfer after sender cancel/reset and receiver reload. Real partial-buffer resume remains protocol-test coverage only. This is one-browser-engine, same-host validation; it does not replace physical mobile devices, Safari, cross-network NAT/TURN testing or large-file throughput benchmarks.

The read-only CI workflow runs syntax checks, protocol tests and browser verification on affected pull requests and main pushes. It uses a credential-free fetch of a validated exact commit SHA from the fixed public repository URL, retains baseline history, and performs no deployment. This avoids checkout-action authentication cleanup failing on unrelated malformed worktree gitlinks already in the repository.

## Existing follow-up issues isolated by browser QA

- The sender can miss the initial receiver-capabilities frame: the baseline receiver was observed with sender `peerAcks === false`, byte-correct receipt and a receiver ACK arriving a few milliseconds after sender completion. The harness therefore observes receipt independently rather than treating the sender status as confirmation. Reproduce with repeated fresh baseline one-file UI transfers and inspect the captured capability/ACK frames. The production ACK logic is intentionally unchanged by this focused fix.
- A zero-byte transfer succeeds and arrives byte-for-byte, but the sender's progress bar can remain at 0% beside its success message. This existing display quirk is not changed here.
