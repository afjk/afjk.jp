# Live transfer speed

Pipe shows a compact speed row on both sides of file transfers. No transfer mode or dashboard is added.

- P2P sender: bytes queued into the browser's DataChannel per second. The label and helper text explicitly distinguish this from arrival at the peer
- P2P receiver: payload bytes received by this page per second
- HTTP sender: bytes reported by XHR upload progress, sent toward the relay
- Browser-managed HTTP file downloads: an explicit unavailable state because the page cannot observe download progress. The existing download flow is retained

## Sampling and lifecycle

Rates use a two-second rolling window, sampled/rendered every 250 ms. Progress callbacks update only a byte counter, so they do not add per-chunk DOM work. A timer ages stalled rates toward zero even if no new progress events arrive. The point buffer is bounded.

Each new file gets its own baseline. Retained resume bytes count toward file progress, but are excluded from the new rate. Each new UI attempt has a generation token, so late callbacks from cancelled/replaced attempts cannot repaint the current readout. Cancellation, errors and unobservable fallback stop timers. Completion changes the label to a per-file average and stops live updates; transfers shorter than 250 ms show an em dash with an explanation rather than an unstable estimate. Empty files produce a finite zero.

Units are decimal bytes per second: KB/s = 1,000 B/s and MB/s = 1,000,000 B/s. They are not bits/s or binary KiB/s. The units and per-file scope are explained beside the readout, in Japanese and English.

The transport's chunking, backpressure, checksums and final-ACK logic are unchanged. Optional file-start callbacks expose the correct baseline to the UI; simultaneous background broadcasts keep their no-op progress callbacks and do not share meter state.

## Verification

```sh
node --test html/assets/js/pipe/transfer-speed.test.js
node --test scripts/pipe-resume-latency.test.mjs
```

Local checks cover units, invalid/empty/short samples, known byte/time rates, stall decay, resume baselines, file resets, bounded rendering, independent directions, cancel/retry stale callbacks, observable HTTP progress, upload completion/error/abort and existing protocol compatibility/integrity/ACK behavior.

The isolated browser harness additionally checks live sender and receiver readouts during synthetic paced file reads over real localhost RTCDataChannels, desktop and 390 px mobile layout, per-frame DOM update bounds, cancellation/reset, actual XHR upload progress under test-only network throttling, and the unavailable browser-managed download state. Synthetic source pacing makes live UI states observable; it is not a production throughput benchmark. Screenshots and result JSON are CI artifacts. The harness retains browser sandboxing and TLS checks, blocks outside endpoints and never benchmarks the production relay.
