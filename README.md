# CPU Metrics Comparison Tool

This tool compares multiple CPU metrics sources side-by-side:

- Legacy-style logic based on `os.cpus()` deltas:
  - `os.cpus()` deltas over a fixed interval
  - `% = (1 - idle_delta / total_delta) * 100`
  - value truncated to integer (`Math.trunc`)
- `systeminformation.currentLoad()` (`currentLoad`, `currentLoadUser`, `currentLoadSystem`)
- macOS `top` CPU line (`user + sys`), which is an Activity Monitor style system CPU number

On Windows it also samples:

- `Win32_PerfFormattedData_PerfOS_Processor` (`_Total.PercentProcessorTime`), which is close to Task Manager overall CPU.

Results are written to:

- CSV data file (all samples)
- Markdown summary file (concise recommendation and evidence)

Default output layout per run:

```text
results/<timestamp>/cpu-metrics.csv
results/<timestamp>/summary.md
```

## Setup

```bash
cd cpu-metrics-compare-tool
npm install
```

## Run

```bash
npm run compare
```

By default, console output is concise (start/end + recommendation). Use `--verbose` for per-sample logs and tables.

Optional arguments:

```bash
node cpu-metrics-compare.js --interval-ms 1000 --duration-sec 300 --warmup-sec 10 --outlier-z 3.5 --low-band-max 20 --medium-band-max 60 --output ./run1.csv --summary-file ./run1.summary.md
```

Options:

- `--interval-ms`: sampling interval for both methods (default `1000`)
- `--duration-sec`: total runtime (default `180`)
- `--warmup-sec`: initial samples excluded from analysis section (default `5`)
- `--outlier-z`: robust z-score threshold for diff outliers (default `3.5`)
- `--low-band-max`: upper bound of low load band in percent (default `20`)
- `--medium-band-max`: upper bound of medium load band in percent (default `60`)
- `--output`: CSV output path
- `--summary-file`: summary markdown output path (default: `summary.md` in the same run folder as CSV)
- `--verbose`: print detailed sample logs and tables to console

Load bands are based on `systeminformation.currentLoad`:

- `low`: `currentLoad < low-band-max`
- `medium`: `currentLoad >= low-band-max` and `< medium-band-max`
- `high`: `currentLoad >= medium-band-max`

## CSV Columns

- `timestamp`
- `legacy_os_cpus_percent`
- `si_currentLoad_percent`
- `si_currentLoadUser_percent`
- `si_currentLoadSystem_percent`
- `mac_top_used_percent`
- `mac_top_user_percent`
- `mac_top_system_percent`
- `mac_top_idle_percent`
- `win_perf_used_percent`
- `diff_si_minus_legacy`
- `diff_mac_top_minus_legacy`
- `diff_mac_top_minus_si`
- `diff_win_perf_minus_legacy`
- `diff_win_perf_minus_si`
- `load_band` (`low`, `medium`, `high` based on `si_currentLoad_percent`)
- `phase` (`warmup` or `sample`)
- `is_outlier` (`1` or `0`, robust outlier on diff)

## Summary File Contents

The generated summary file includes:

- Run context and configuration
- Data quality (sample count, outliers)
- Evidence against platform reference metric
- Load-band snapshot
- Final recommendation with confidence

## Suggested Test Flow

1. Open your platform CPU monitor:
  - macOS: Activity Monitor -> CPU
  - Windows: Task Manager -> Performance -> CPU
2. Start this probe.
3. Run a repeatable workload (idle, medium, high).
4. Keep the same run length for each workload (for example, 3-5 minutes).
5. Compare probe CSV timestamps with observed system monitor values and trends.

## Notes

- Legacy output is intentionally truncated to simulate coarse integer CPU reporting.
- `systeminformation.currentLoad()` returns a floating-point percentage with more granularity.
- Sampling itself has small overhead; keep interval at 1000 ms unless you need finer detail.
- Recommendation logic is MAE-first (mean absolute error) to avoid contradictory winner messages.
- On non-macOS systems, `mac_top_*` fields will be `n/a`.
- On non-Windows systems, `win_perf_*` fields will be `n/a`.

Platform-aware behavior:

- On macOS, live line output includes `top=...` and excludes Windows reference text.
- On Windows, live line output includes `win=...` and excludes macOS reference text.
- Final Evidence/Conclusion uses the active platform reference only.
