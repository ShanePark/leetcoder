# Performance verification — 2026-09-12

The audit started from `87dab176f79daef070953d4b48169b8e89a867bc` on macOS
arm64, with Node 24.15.0 and Rust 1.98.1. It covered app startup and teardown,
sidebar/card/tab rendering, Java source analysis and formatting, native file
enumeration and containment checks, HTTP requests, Git path selection, JDK
discovery, and native command dispatch.

These are local measurements of specific operations, not a claim that every
interaction or machine is faster. Timings depend on source size, installed
JDKs, filesystem caches, and system load. Automated native measurements use
the debug test profile unless stated otherwise. They must not be interpreted
as production WebView frame timings.

## Confirmed rendering and editor improvements

| Operation and input | Before | After | Measurement |
| --- | ---: | ---: | --- |
| File selection render, 2,353 visible files | 18.85 ms | 2.30 ms | Browser DOM plus forced layout, median of 20 alternating samples |
| Format Java, 58,906-byte source | 137.4703 ms | 21.9675 ms | Same-process source comparison, median of 20 samples |
| Mask comments/literals, 58,906 bytes | 1.2308 ms | 0.6995 ms | Same-process source comparison, median of 20 samples |
| Resolve definition, 58,906 bytes | 2.1408 ms | 1.5684 ms | Same-process source comparison, median of 20 samples |
| Format Java, 2,184-byte source | 0.9890 ms | 0.8428 ms | Same-process source comparison, median of 20 samples |

The file renderer previously recreated every row and listener on unrelated
app renders. It now retains the structure while updating selection, open,
busy, and expansion state in place. File metadata snapshots invalidate the
cache, including replacement entries in an otherwise unchanged array.
Events use current callbacks and file records. The daily card and tab strip
also retain unchanged controls, preserving input/tab focus and avoiding
unnecessary DOM work.

The browser harness uses separate, equivalent attached containers, four
alternating warmups and 20 alternating measurements. Both renderers produced
the same layout checksum on every sample (101,329 each; 2,026,580 total).
The baseline is the renderer from the starting revision with benchmark import,
name, type, comment, and formatting adjustments. It uses a simple 420-pixel
pane, not the full desktop stylesheet. The p95 values were 21.5 ms and 8.3 ms.
This measures repeated selection renders after initial construction, not
first-load time. Focus, callbacks, invalidation, grouping, and busy states
are covered by separate functional tests.

The formatter formerly rebuilt whole strings for each whitespace edit and
repeatedly searched earlier line boundaries. It now assembles non-overlapping
edits once and tracks line starts. Comment/literal masking copies ranges
while preserving UTF-16 offsets, line breaks, and literal placeholders.
Unused-import removal scans candidates once and preserves identifiers that
merely contain a known import name.

The editor comparison snapshots both revisions, verifies Git blobs and SHA-256
hashes, loads both implementations in one process, alternates execution order,
and checks exact mask/format output equality before timing. Its sources are
exactly 2,184 and 58,906 ASCII bytes (12 and 360 generated methods). Large-file
analysis changed from 9.9260 to 9.2544 ms; small-file analysis changed from
0.1501 to 0.1562 ms, so no small-file analysis improvement is claimed.
An earlier exploratory formatter measurement used inconsistent fixtures and
was discarded. Statement-completion experiments that changed output were
also discarded; statement-completion behavior is unchanged.

## Native file and network work

| Operation and input | Before | After | Measurement |
| --- | ---: | ---: | --- |
| Enumerate 2,353 source files | 9.563667 ms | 4.238584 ms | 10 warmups, 30 alternating samples; identical sorted entries |
| 12 sequential HTTP/1.1 requests | 12 sockets / 13.796 ms | 1 socket / 4.050 ms | Controlled local keep-alive server, identical request headers |
| HTTP client construction/clone | 9,000 ns | 42 ns | Manual client benchmark median |

Directory enumeration now uses directory-entry file types instead of an
extra metadata query for every entry. Symlinks remain excluded and containment
checks are retained. The fixture matches the observed source-file count and
difficulty distribution: 600 easy, 1,361 medium and 392 hard. Path resolution
(about 0.073 ms) and reading a file (about 0.100 ms) were not identified as
material bottlenecks and were left unchanged.

Requests share a lazily initialized HTTP client and its connection pool.
Initialization failures are not cached. The network benchmark verifies
connection reuse locally; external service, DNS, TLS and internet latency
were not compared, so the local speedup is not an end-to-end internet claim.

## Command dispatch and lifecycle

On this host, full JDK discovery median fell from **462.065 ms to 360.376 ms**
(22.0%). The production function and sequential baseline each ran four warmup
pairs and 20 measured pairs with alternating order; the parallel version was
faster in 18 of 20 pairs. Every pair selected the same Java 17.0.18 installation.
The seven independent macOS version queries now run concurrently, while
results are consumed in the original version order. Candidate enumeration,
deduplication, probing, fallback, and equal-version preference are preserved.
A fake helper completes out of order and fails one version to verify that
selection inputs still match sequential discovery. Linux discovery is unchanged.
This keeps the number of queries the same but permits up to seven simultaneous
helper processes. It does not cache installations between calls. Earlier
early-return approaches were discarded because they could change JDK selection.

Git rename-source lookup previously scanned the full status list for every
selected file. Multi-file selection now builds one lookup map; a single-file
selection keeps the direct scan. Duplicate status entries retain first-match
behavior, and original paths still pass containment validation.

For 10,000 changed paths and 500 selected renamed files, lookup median fell
from **23.5895 ms to 4.7270 ms per call**. The benchmark uses four warmups,
20 alternating samples, and 10 calls per sample, comparing complete output
vectors as well as checksums (200,000 each). A separate 2,000-file temporary
Git repository verified production selection and path validation, taking
39.952 ms for 500 selected paths. That latter fixture has no timed baseline;
it is not evidence of a whole-Git-operation speedup.

Project validation, file listing, Git status and Git diff now run on blocking
workers. Wire command names, argument shapes and response DTOs are unchanged.
Mutating commands retain their existing execution behavior.

| Read operation, 2,000-file temporary repository | Synchronous call occupied time | First async poll occupied time |
| --- | ---: | ---: |
| Validate project | 0.159 ms | 0.011 ms |
| List files | 5.170 ms | 0.013 ms |
| Git status | 51.560 ms | 0.017 ms |
| Git diff | 93.913 ms | 0.018 ms |

These medians use five warmups and 20 samples. The benchmark polls the actual
command future once and completes that same future outside the timed interval;
it measures time occupying the caller, not completion latency or native IPC
frame responsiveness. A separate real temporary-repository test checks all
four command results against the direct operations.

Remembered local repositories now initialize while the daily request is
pending, so a slow network response no longer gates local file availability.
A deferred-response test checks that ordering. Update polling stops while
the document is hidden and resumes with one immediate check when visible.
This does not imply polling stops for every occluded desktop window.
Repository validation and file listings that finish after teardown no longer
reactivate the app or render disposed views. A watcher whose installation
finishes late is stopped again. Deferred validation/list/watch tests cover
these boundaries, and failed save/close attempts keep the app available for
a retry.

## Reproduction

Run timing workloads separately from compilation and other benchmarks.
Regular tests intentionally do not enforce machine-dependent timing limits.

```sh
node scripts/performance/compare-editor.mjs
npm run dev -- --host 127.0.0.1
# Open http://127.0.0.1:1420/tests/performance/app-views.html in a browser.

cargo test --manifest-path src-tauri/Cargo.toml repository::tests::benchmark_repository_hot_paths -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml leetcode::tests::benchmark_client -- --ignored --nocapture --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml git::tests::benchmark_ -- --ignored --nocapture --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml runner::tests::benchmark_java_discovery -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml commands::tests::benchmark_read_only_command_dispatch -- --ignored --nocapture
```

The editor script writes `/tmp/leetcoder-editor-comparison.log`; set
`EDITOR_COMPARISON_LOG` to change that location. The browser prints raw timing
and checksum arrays in the page. Rust benchmarks print their measurements
with `--nocapture`. Local HTTP benchmarks need loopback socket access.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | 466 tests in 53 files passed |
| `npm run build` | Passed; pre-existing chunk-size warning retained |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | Passed |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 81 passed; 7 manual benchmarks ignored by the regular suite |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Passed |
| Seven manual native benchmarks listed above | Passed when explicitly invoked |
| Browser renderer comparison | Matching layout checksums for all 20 sample pairs |
| Editor source comparison | Exact mask/format output equality on both fixtures |

The starting revision passed 445 frontend tests and 76 native tests. New tests
cover behavior and output parity; they do not loosen the existing checks.
`npm run rebuild` is required to build, install and restart the desktop app;
its output is written to `leetcoder-rebuild.log` in the system temporary directory.

## Scope and limitations

The final full-suite run also exposed an existing method-rename defect under
load: parsing was completed but the returned tree was discarded, and analysis
could consume the state's older partial tree. The failure returned only a
declaration range while omitting later calls. The rename implementation at
the starting revision and before this fix had the same Git blob
(`c2f1adc0ede741cc2f24bf0783eb12f8bb4e8fd4`). This is a correctness finding,
not an additional claimed timing improvement. Rename analysis now publishes
and checks the complete parsed tree before walking it. A deterministic test
places a call after 220 filler methods, beyond the initial parse viewport;
the declaration and later call must both be included. The focused rename
suite passed all 15 tests after the fix.

The audit retained existing watcher coalescing/debouncing and filesystem
security checks. It did not introduce a filesystem index cache with a new
freshness policy, cache JDK discovery across calls, change test-run timeouts,
or alter shortcut bindings. Git network operations and Gradle task execution
depend on external processes and were not assigned speculative speedups.

Linux desktop execution and installation, long-duration memory/energy use,
and external-service latency were not verified on this macOS host. The existing
large JavaScript chunk warning remains; the audit did not add dependencies
or claim a bundle-size improvement.
