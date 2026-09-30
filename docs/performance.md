# Performance audit — 2026-09-12

Historical measurements from macOS arm64, Node 24.15.0, and Rust 1.98.1,
starting at `87dab176f79daef070953d4b48169b8e89a867bc`. The audit covered
startup/teardown, views, Java analysis/formatting, file enumeration/security,
HTTP reuse, Git path selection, JDK discovery, and native command dispatch.
These results do not verify later refactors or the current installed application.

Timings measure specific local operations, not every interaction or machine.
Source size, installed JDKs, filesystem caches, and load affect results. Native
measurements use the debug test profile unless stated otherwise; they are not
production WebView frame timings. Regular tests enforce behavior, not timing limits.

## Rendering and editor

| Operation/input | Before | After | Method |
| --- | ---: | ---: | --- |
| File selection render, 2,353 visible files | 18.85 ms | 2.30 ms | DOM + forced layout; 20 alternating samples, median |
| Format Java, 58,906 bytes | 137.4703 ms | 21.9675 ms | Same-process comparison; 20 samples, median |
| Mask comments/literals, 58,906 bytes | 1.2308 ms | 0.6995 ms | Same comparison |
| Resolve definition, 58,906 bytes | 2.1408 ms | 1.5684 ms | Same comparison |
| Format Java, 2,184 bytes | 0.9890 ms | 0.8428 ms | Same comparison |

File rows/listeners are retained across unrelated renders; selection, open,
busy, and expansion state update in place. Metadata snapshots invalidate the
cache even when entries are replaced in the same array. Events use current
callbacks/records. Unchanged daily-card/tab controls retain focus. Separate
functional tests cover focus, callbacks, invalidation, grouping, and busy states.

The browser harness attaches equivalent containers, alternates four warmups
and 20 measurements, and obtains identical layout checksums (101,329 each;
2,026,580 total). Selection-render p95 was 21.5 ms before and 8.3 ms after.
The baseline is the starting renderer with benchmark import/name/type/comment/
formatting adjustments. Its simple 420-pixel pane does not use the full desktop
stylesheet; it measures repeated selection after construction, not first load.

Formatting now assembles non-overlapping edits once and tracks line starts,
rather than rebuilding strings and searching earlier boundaries repeatedly.
Masking copies ranges while preserving UTF-16 offsets, line breaks, and literal
placeholders. Unused-import removal scans candidates once without mistaking
identifiers containing an import name for that import.

The editor harness snapshots both revisions, verifies Git blobs/SHA-256,
loads implementations in one process, alternates order, and checks exact
mask/format equality before timing. Fixtures are 2,184 and 58,906 ASCII bytes
(12/360 generated methods). Large-file analysis changed from 9.9260 to 9.2544 ms;
small-file analysis changed from 0.1501 to 0.1562 ms, so no small-file analysis
improvement is claimed. An inconsistent-fixture formatter trial and
output-changing statement-completion experiments were discarded; statement
completion behavior was unchanged.

## Native operations

| Operation/input | Before | After | Method |
| --- | ---: | ---: | --- |
| Enumerate 2,353 source files | 9.563667 ms | 4.238584 ms | 10 warmups, 30 alternating samples; identical sorted entries |
| 12 sequential HTTP/1.1 requests | 12 sockets / 13.796 ms | 1 socket / 4.050 ms | Local keep-alive server; identical headers |
| HTTP client construction/clone | 9,000 ns | 42 ns | Manual benchmark median |
| Full macOS JDK discovery | 462.065 ms | 360.376 ms | 4 warmup pairs, 20 alternating pairs; identical selected JDK |
| Rename-source lookup, 10,000 changed / 500 selected paths | 23.5895 ms | 4.7270 ms | 4 warmups, 20 alternating samples, 10 calls/sample; complete vectors/checksums equal |

Enumeration uses directory-entry types instead of per-entry metadata calls;
symlink exclusion and containment checks remain. The fixture contains 600 easy,
1,361 medium, and 392 hard files, matching the observed distribution. Path
resolution (~0.073 ms) and reading (~0.100 ms) were not material bottlenecks.
A lazy shared HTTP client pools connections without caching initialization
failures. DNS, TLS, external services, and internet latency were not compared.

Seven independent macOS version queries run concurrently, with results consumed
in original order. Enumeration, deduplication, probing, fallback, equal-version
preference, and Linux discovery remain unchanged. Every measured pair chose
Java 17.0.18; concurrent discovery was faster in 18/20 pairs (22.0% median gain).
An out-of-order fake helper with one failed version checks parity. Up to seven
helpers may run together, and installations are not cached across calls.
Early-return approaches were discarded because they could change selection.

Multi-file Git selection builds one rename lookup map; single-file selection
keeps the direct scan. Duplicate status entries retain first-match behavior,
and original paths still pass containment validation. Benchmark checksums were
200,000 each. A separate real 2,000-file repository took 39.952 ms to select
500 paths with production validation, but had no timed baseline; it does not
establish a whole-Git-operation speedup.

## Command dispatch and lifecycle

Project validation, file listing, Git status, and diff moved to blocking workers,
preserving command names, argument shapes, response DTOs, and mutation behavior.

| Read operation, 2,000-file repository | Synchronous caller occupied | First async poll occupied |
| --- | ---: | ---: |
| Validate project | 0.159 ms | 0.011 ms |
| List files | 5.170 ms | 0.013 ms |
| Git status | 51.560 ms | 0.017 ms |
| Git diff | 93.913 ms | 0.018 ms |

Five warmups/20 samples measure one poll of the actual command future; that
same future completes outside the timed interval. This measures caller
occupation, not completion latency or native IPC frame responsiveness. A real
temporary-repository test compares all four command results to direct operations.

Remembered repositories initialize while daily requests are pending. Update
polling stops when the document is hidden and resumes with one immediate check;
this does not cover every occluded desktop window. Validation/listing results
after teardown cannot reactivate or render the app, and late watcher installation
is stopped again. Deferred-response/validation/list/watch tests verify these
boundaries; failed save/close attempts keep the app available for retry.

## Reproduction and historical verification

Run timings apart from compilation and other benchmarks:

```sh
node scripts/performance/compare-editor.mjs
npm run dev -- --host 127.0.0.1
# Open http://127.0.0.1:1420/tests/performance/app-views.html in a browser.
```

For native benchmarks, use function-name filters so module extraction does not
change invocation. Run sequentially with a disposable target:

```sh
(
  export CARGO_TARGET_DIR="$(mktemp -d /tmp/leetcoder-bench.XXXXXX)"
  export CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1
  trap 'rm -rf "$CARGO_TARGET_DIR"' EXIT
  for benchmark in benchmark_repository_hot_paths benchmark_client \
    benchmark_rename_source_lookup benchmark_changed_path_selection_with_git_fixture \
    benchmark_java_discovery benchmark_read_only_command_dispatch
  do
    cargo test --manifest-path src-tauri/Cargo.toml "$benchmark" \
      -- --ignored --nocapture --test-threads=1
  done
)
```

The editor log is `/tmp/leetcoder-editor-comparison.log` (override with
`EDITOR_COMPARISON_LOG`); the browser prints raw timings/checksums. Rust prints
measurements with `--nocapture`; local HTTP tests require loopback sockets.

At the audit's conclusion, frontend typecheck/build and Rust format/check passed;
466 frontend tests in 53 files and 81 native tests passed, with seven manual
benchmarks ignored by the regular suite and passing when invoked explicitly.
Browser checksum parity and exact editor mask/format equality passed. The
starting revision passed 445 frontend and 76 native tests. Added checks covered
behavior/output parity without weakening existing assertions. The pre-existing
JavaScript chunk warning remained. Current verification and desktop rebuild
requirements are in [architecture](architecture.md#refactoring-and-verification)
and [README](../README.md#install-run-and-build), including the rebuild log.

## Correctness finding and limits

The full suite exposed a pre-existing method-rename defect under load: a completed
parse tree was discarded, allowing analysis of an older partial tree that omitted
later calls. The starting/pre-fix implementation shared Git blob
`c2f1adc0ede741cc2f24bf0783eb12f8bb4e8fd4`. Analysis now publishes/checks the
complete tree before walking it. A call after 220 filler methods must be included
alongside its declaration; all 15 focused rename tests passed. This was a
correctness fix, not a timing claim.

Watcher coalescing/debouncing, security, test timeouts, and shortcuts were retained.
No filesystem index/freshness policy, cross-call JDK cache, new dependencies,
bundle-size gain, or speculative Git-network/Gradle speedup was introduced.
Linux desktop installation/execution, long-duration memory/energy use, and
external-service latency were not verified on the audit's macOS host.
