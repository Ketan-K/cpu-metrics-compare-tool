#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

let si;
try {
  si = require("systeminformation");
} catch (error) {
  console.error("Missing dependency: systeminformation");
  console.error("Run: npm install");
  process.exit(1);
}

function getArgValue(name, fallback) {
  const exact = process.argv.find(arg => arg.startsWith(`${name}=`));
  if (exact) {
    return exact.slice(name.length + 1);
  }
  const index = process.argv.findIndex(arg => arg === name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getCPUInfo() {
  return os.cpus().reduce(
    (result, cpuInfo) => {
      result.idle += cpuInfo.times.idle;
      result.total +=
        cpuInfo.times.user +
        cpuInfo.times.nice +
        cpuInfo.times.sys +
        cpuInfo.times.irq +
        cpuInfo.times.idle;
      return result;
    },
    { idle: 0, total: 0 }
  );
}

async function legacyCpuUsage(windowMs) {
  const statsBegin = getCPUInfo();
  await sleep(windowMs);
  const statsEnd = getCPUInfo();

  const idle = statsEnd.idle - statsBegin.idle;
  const total = statsEnd.total - statsBegin.total;
  let perc = total !== 0 ? idle / total : 1;
  perc = (1 - perc) * 100;

  // Match existing implementation in system-info.service.ts
  return Math.trunc(perc);
}

async function getMacTopCpuUsage() {
  if (process.platform !== "darwin") {
    return undefined;
  }

  try {
    // top output line example:
    // CPU usage: 7.80% user, 6.41% sys, 85.78% idle
    const { stdout } = await execFileAsync("top", ["-l", "1", "-n", "0"]);
    const line = stdout
      .split(/\r?\n/)
      .find(item => item.toLowerCase().includes("cpu usage:"));

    if (!line) {
      return undefined;
    }

    const match = line.match(/CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys,\s*([\d.]+)%\s*idle/i);
    if (!match) {
      return undefined;
    }

    const user = Number.parseFloat(match[1]);
    const system = Number.parseFloat(match[2]);
    const idle = Number.parseFloat(match[3]);
    const used = Number((user + system).toFixed(2));

    return {
      used,
      user: Number(user.toFixed(2)),
      system: Number(system.toFixed(2)),
      idle: Number(idle.toFixed(2))
    };
  } catch (_error) {
    return undefined;
  }
}

async function getWindowsPerfCpuUsage() {
  if (process.platform !== "win32") {
    return undefined;
  }

  try {
    // Win32_PerfFormattedData provides cooked total CPU % similar to Task Manager overall CPU.
    const ps = "(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\").PercentProcessorTime";
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true });
    const match = stdout.match(/(-?\d+(?:\.\d+)?)/);
    if (!match) {
      return undefined;
    }

    const used = Number.parseFloat(match[1]);
    if (!Number.isFinite(used)) {
      return undefined;
    }

    return {
      used: Number(used.toFixed(2))
    };
  } catch (_error) {
    return undefined;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) {
    return NaN;
  }
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function stats(values) {
  if (!values.length) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9)
  };
}

function mean(values) {
  if (!values.length) {
    return NaN;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function stddev(values) {
  if (values.length < 2) {
    return 0;
  }
  const avg = mean(values);
  const variance = values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function correlation(a, b) {
  if (!a.length || a.length !== b.length) {
    return NaN;
  }
  const avgA = mean(a);
  const avgB = mean(b);

  let numerator = 0;
  let sumSqA = 0;
  let sumSqB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - avgA;
    const db = b[i] - avgB;
    numerator += da * db;
    sumSqA += da * da;
    sumSqB += db * db;
  }

  const denominator = Math.sqrt(sumSqA * sumSqB);
  if (denominator === 0) {
    return NaN;
  }
  return numerator / denominator;
}

function median(values) {
  if (!values.length) {
    return NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function robustOutlierScore(value, values) {
  if (values.length < 8) {
    return 0;
  }
  const med = median(values);
  const absDevs = values.map(item => Math.abs(item - med));
  const mad = median(absDevs);
  if (mad === 0) {
    return 0;
  }
  // 0.6745 makes score comparable to z-score for normal distribution.
  return (0.6745 * (value - med)) / mad;
}

function getLoadBand(siLoad, thresholds) {
  if (siLoad < thresholds.lowMax) {
    return "low";
  }
  if (siLoad < thresholds.mediumMax) {
    return "medium";
  }
  return "high";
}

function printBandStats(label, values) {
  const s = stats(values);
  if (!s) {
    console.log(`${label}: n/a`);
    return;
  }
  console.log(`${label}: avg=${fmt(s.avg)} min=${fmt(s.min)} max=${fmt(s.max)} count=${s.count}`);
}

function printInterpretation({
  diffAvg,
  diffStd,
  corr,
  directionAgreement,
  outlierCount,
  sampleCount,
  warmupSamples,
  bandDiffs
}) {
  console.log("\nInterpretation");

  if (Number.isFinite(diffAvg)) {
    if (Math.abs(diffAvg) <= 3) {
      console.log(`- Mean bias is small (${fmt(diffAvg)}%). Both methods are close on average.`);
    } else if (diffAvg > 0) {
      console.log(`- systeminformation reads higher on average by ${fmt(diffAvg)}%.`);
    } else {
      console.log(`- Legacy os.cpus() reads higher on average by ${fmt(Math.abs(diffAvg))}%.`);
    }
  }

  if (Number.isFinite(corr)) {
    if (corr >= 0.9) {
      console.log(`- Strong trend match (correlation ${fmt(corr, 3)}).`);
    } else if (corr >= 0.75) {
      console.log(`- Moderate trend match (correlation ${fmt(corr, 3)}).`);
    } else {
      console.log(`- Weak trend match (correlation ${fmt(corr, 3)}).`);
    }
  }

  if (Number.isFinite(directionAgreement)) {
    console.log(`- Direction agreement: ${fmt(directionAgreement * 100)}% of consecutive samples moved in the same direction.`);
  }

  if (Number.isFinite(diffStd)) {
    console.log(`- Difference variability (standard deviation): ${fmt(diffStd)}%.`);
  }

  const outlierPct = sampleCount ? (outlierCount / sampleCount) * 100 : NaN;
  if (Number.isFinite(outlierPct)) {
    console.log(`- Difference outliers: ${outlierCount}/${sampleCount} (${fmt(outlierPct)}%).`);
  }

  const lowAvg = mean(bandDiffs.low);
  const medAvg = mean(bandDiffs.medium);
  const highAvg = mean(bandDiffs.high);
  if (Number.isFinite(lowAvg) || Number.isFinite(medAvg) || Number.isFinite(highAvg)) {
    console.log(`- Bias by load band (systeminformation minus legacy): low=${fmt(lowAvg)}%, medium=${fmt(medAvg)}%, high=${fmt(highAvg)}%`);
  }

  if (warmupSamples > 0) {
    console.log(`- Warmup samples excluded from analysis: ${warmupSamples}.`);
  }
}

function getReferenceMetricInfo() {
  if (process.platform === "darwin") {
    return {
      metric: "mac_top_used_percent",
      label: "macOS top (Activity Monitor style)"
    };
  }
  if (process.platform === "win32") {
    return {
      metric: "win_perf_used_percent",
      label: "Windows PerfOS _Total (Task Manager style)"
    };
  }
  return undefined;
}

function mae(predicted, actual) {
  if (!predicted.length || predicted.length !== actual.length) {
    return NaN;
  }
  let total = 0;
  for (let i = 0; i < predicted.length; i += 1) {
    total += Math.abs(predicted[i] - actual[i]);
  }
  return total / predicted.length;
}

function rmse(predicted, actual) {
  if (!predicted.length || predicted.length !== actual.length) {
    return NaN;
  }
  let total = 0;
  for (let i = 0; i < predicted.length; i += 1) {
    const error = predicted[i] - actual[i];
    total += error * error;
  }
  return Math.sqrt(total / predicted.length);
}

function meanBias(predicted, actual) {
  if (!predicted.length || predicted.length !== actual.length) {
    return NaN;
  }
  let total = 0;
  for (let i = 0; i < predicted.length; i += 1) {
    total += predicted[i] - actual[i];
  }
  return total / predicted.length;
}

function buildEvidence(name, predicted, actual) {
  const bias = meanBias(predicted, actual);
  const maeValue = mae(predicted, actual);
  const rmseValue = rmse(predicted, actual);
  const corrValue = correlation(predicted, actual);
  const corrPenalty = Number.isFinite(corrValue)
    ? (1 - Math.max(-1, Math.min(1, corrValue))) * 4
    : 2;

  // Lower score is better. Bias/MAE/RMSE are primary, trend mismatch is secondary.
  const score =
    (Number.isFinite(maeValue) ? maeValue : 50) +
    (Number.isFinite(rmseValue) ? rmseValue * 0.5 : 25) +
    (Number.isFinite(bias) ? Math.abs(bias) * 0.5 : 25) +
    corrPenalty;

  return {
    name,
    bias,
    mae: maeValue,
    rmse: rmseValue,
    corr: corrValue,
    score
  };
}

function printEvidenceAndConclusion(rows, referenceInfo) {
  if (!referenceInfo) {
    console.log("\nEvidence");
    console.log("- No platform reference metric available for this OS.");
    return;
  }

  if (rows.length < 8) {
    console.log("\nEvidence");
    console.log(`- Not enough reference-aligned samples for conclusion (have ${rows.length}, need at least 8).`);
    return;
  }

  const refs = rows.map(item => item.ref);
  const legacyPred = rows.map(item => item.legacy);
  const siPred = rows.map(item => item.si);

  const legacyEvidence = buildEvidence("legacy_os_cpus_percent", legacyPred, refs);
  const siEvidence = buildEvidence("si_currentLoad_percent", siPred, refs);
  const ranked = [legacyEvidence, siEvidence].sort((a, b) => a.score - b.score);

  printTable(
    `Evidence Compared To Reference (${referenceInfo.label})`,
    [
      "Metric",
      "Mean Absolute Error",
      "Root Mean Squared Error",
      "Mean Bias",
      "Correlation",
      "Composite Score"
    ],
    ranked.map(item => [
      item.name,
      fmt(item.mae),
      fmt(item.rmse),
      fmt(item.bias),
      fmt(item.corr, 3),
      fmt(item.score)
    ])
  );

  const winner = ranked[0];
  const loser = ranked[1];
  const scoreGap = loser.score - winner.score;
  const maeGap = loser.mae - winner.mae;
  const confidence =
    scoreGap >= 5 && rows.length >= 30
      ? "high"
      : scoreGap >= 2 && rows.length >= 20
        ? "medium"
        : "low";

  console.log("\nConclusion");
  console.log(
    `- Recommended metric for ${process.platform}: ${winner.name}`
  );
  console.log(
    `- Evidence: ${winner.name} is closer to ${referenceInfo.metric} by MAE improvement ${fmt(maeGap)} points and score gap ${fmt(scoreGap)} (${confidence} confidence, n=${rows.length}).`
  );
  console.log(
    `- Practical note: Use this as directional evidence under controlled workloads; Activity Monitor/Task Manager UI sampling and smoothing can still differ slightly.`
  );
  console.log("- Abbreviation guide: MAE = Mean Absolute Error, RMSE = Root Mean Squared Error.");
}

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function padRight(value, width) {
  const text = String(value);
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function printTable(title, headers, rows) {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log("(no rows)");
    return;
  }

  const widths = headers.map((header, index) => {
    return rows.reduce(
      (max, row) => Math.max(max, String(row[index]).length),
      String(header).length
    );
  });

  const divider = `+-${widths.map(width => "-".repeat(width)).join("-+-")}-+`;
  const headerLine = `| ${headers.map((header, index) => padRight(header, widths[index])).join(" | ")} |`;

  console.log(divider);
  console.log(headerLine);
  console.log(divider);
  rows.forEach(row => {
    console.log(`| ${row.map((cell, index) => padRight(cell, widths[index])).join(" | ")} |`);
  });
  console.log(divider);
}

function metricRow(label, metric) {
  if (!metric) {
    return [label, "n/a", "n/a", "n/a", "n/a", "n/a", "n/a"];
  }
  return [
    label,
    metric.count,
    fmt(metric.min),
    fmt(metric.max),
    fmt(metric.avg),
    fmt(metric.median),
    fmt(metric.p90)
  ];
}

function printStats(label, metric) {
  if (!metric) {
    console.log(`${label}: n/a`);
    return;
  }

  console.log(
    `${label}: count=${metric.count}, min=${fmt(metric.min)}, max=${fmt(metric.max)}, avg=${fmt(metric.avg)}, median=${fmt(metric.median)}, p75=${fmt(metric.p75)}, p90=${fmt(metric.p90)}`
  );
}

async function main() {
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";
  const intervalMs = toNumber(getArgValue("--interval-ms", "1000"), 1000);
  const durationSec = toNumber(getArgValue("--duration-sec", "180"), 180);
  const warmupSec = Math.max(0, toNumber(getArgValue("--warmup-sec", "5"), 5));
  const outlierZ = Math.max(2.5, toNumber(getArgValue("--outlier-z", "3.5"), 3.5));
  const lowBandMax = Math.max(1, toNumber(getArgValue("--low-band-max", "20"), 20));
  const mediumBandMax = Math.max(lowBandMax + 1, toNumber(getArgValue("--medium-band-max", "60"), 60));
  const loadBandThresholds = {
    lowMax: lowBandMax,
    mediumMax: mediumBandMax
  };
  const outputArg = getArgValue("--output", "");
  const outputPath = outputArg
    ? path.resolve(outputArg)
    : path.resolve(`cpu-compare-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
  const referenceInfo = getReferenceMetricInfo();

  const startAt = Date.now();
  let shouldStop = false;
  process.on("SIGINT", () => {
    if (!shouldStop) {
      shouldStop = true;
      console.log("\nCtrl+C received. Finishing current sample and writing summary...");
    }
  });

  const header = [
    "timestamp",
    "legacy_os_cpus_percent",
    "si_currentLoad_percent",
    "si_currentLoadUser_percent",
    "si_currentLoadSystem_percent",
    "mac_top_used_percent",
    "mac_top_user_percent",
    "mac_top_system_percent",
    "mac_top_idle_percent",
    "win_perf_used_percent",
    "diff_si_minus_legacy",
    "diff_mac_top_minus_legacy",
    "diff_mac_top_minus_si",
    "diff_win_perf_minus_legacy",
    "diff_win_perf_minus_si",
    "load_band",
    "phase",
    "is_outlier"
  ].join(",");

  fs.writeFileSync(outputPath, `${header}\n`, "utf8");

  console.log("Starting CPU comparison sampling");
  console.log(`interval_ms=${intervalMs}, duration_sec=${durationSec}, warmup_sec=${warmupSec}, output=${outputPath}`);
  console.log(
    `load_band_definition: low < ${loadBandThresholds.lowMax}%, medium >= ${loadBandThresholds.lowMax}% and < ${loadBandThresholds.mediumMax}%, high >= ${loadBandThresholds.mediumMax}% (based on systeminformation currentLoad)`
  );
  console.log("Press Ctrl+C to stop early.");

  const legacyValues = [];
  const siValues = [];
  const macTopValues = [];
  const winPerfValues = [];
  const diffValues = [];
  const diffTopLegacyValues = [];
  const diffTopSiValues = [];
  const diffWinLegacyValues = [];
  const diffWinSiValues = [];
  const bandDiffs = { low: [], medium: [], high: [] };
  const analysisLegacy = [];
  const analysisSi = [];
  const analysisDiffs = [];
  const analysisReferenceRows = [];
  let outlierCount = 0;
  let trendComparableCount = 0;
  let trendSameDirectionCount = 0;
  let prevLegacy;
  let prevSi;
  let warmupSamples = 0;

  const stopAt = Date.now() + durationSec * 1000;
  let sampleCount = 0;

  while (Date.now() < stopAt && !shouldStop) {
    const [legacy, currentLoad, macTop, winPerf] = await Promise.all([
      legacyCpuUsage(intervalMs),
      si.currentLoad(),
      getMacTopCpuUsage(),
      getWindowsPerfCpuUsage()
    ]);

    const siLoad = Number(currentLoad.currentLoad.toFixed(2));
    const siUser = Number(currentLoad.currentLoadUser.toFixed(2));
    const siSystem = Number(currentLoad.currentLoadSystem.toFixed(2));
    const topUsed = macTop ? macTop.used : NaN;
    const topUser = macTop ? macTop.user : NaN;
    const topSystem = macTop ? macTop.system : NaN;
    const topIdle = macTop ? macTop.idle : NaN;
    const winUsed = winPerf ? winPerf.used : NaN;
    const referenceUsed = Number.isFinite(topUsed)
      ? topUsed
      : Number.isFinite(winUsed)
        ? winUsed
        : NaN;
    const diff = Number((siLoad - legacy).toFixed(2));
    const diffTopLegacy = Number.isFinite(topUsed)
      ? Number((topUsed - legacy).toFixed(2))
      : NaN;
    const diffTopSi = Number.isFinite(topUsed)
      ? Number((topUsed - siLoad).toFixed(2))
      : NaN;
    const diffWinLegacy = Number.isFinite(winUsed)
      ? Number((winUsed - legacy).toFixed(2))
      : NaN;
    const diffWinSi = Number.isFinite(winUsed)
      ? Number((winUsed - siLoad).toFixed(2))
      : NaN;
    const ts = new Date().toISOString();
    const elapsedSec = (Date.now() - startAt) / 1000;
    const isWarmup = elapsedSec < warmupSec;
    const phase = isWarmup ? "warmup" : "sample";
    const loadBand = getLoadBand(siLoad, loadBandThresholds);

    let outlierScore = 0;
    let isOutlier = false;
    if (!isWarmup) {
      outlierScore = Math.abs(robustOutlierScore(diff, analysisDiffs));
      isOutlier = outlierScore >= outlierZ;
      if (isOutlier) {
        outlierCount += 1;
      }
    } else {
      warmupSamples += 1;
    }

    const row = [
      ts,
      legacy,
      siLoad,
      siUser,
      siSystem,
      fmt(topUsed),
      fmt(topUser),
      fmt(topSystem),
      fmt(topIdle),
      fmt(winUsed),
      diff,
      fmt(diffTopLegacy),
      fmt(diffTopSi),
      fmt(diffWinLegacy),
      fmt(diffWinSi),
      loadBand,
      phase,
      isOutlier ? "1" : "0"
    ].join(",");

    fs.appendFileSync(outputPath, `${row}\n`, "utf8");

    legacyValues.push(legacy);
    siValues.push(siLoad);
    if (Number.isFinite(topUsed)) {
      macTopValues.push(topUsed);
    }
    if (Number.isFinite(winUsed)) {
      winPerfValues.push(winUsed);
    }
    diffValues.push(diff);
    if (Number.isFinite(diffTopLegacy)) {
      diffTopLegacyValues.push(diffTopLegacy);
    }
    if (Number.isFinite(diffTopSi)) {
      diffTopSiValues.push(diffTopSi);
    }
    if (Number.isFinite(diffWinLegacy)) {
      diffWinLegacyValues.push(diffWinLegacy);
    }
    if (Number.isFinite(diffWinSi)) {
      diffWinSiValues.push(diffWinSi);
    }

    if (!isWarmup) {
      analysisLegacy.push(legacy);
      analysisSi.push(siLoad);
      analysisDiffs.push(diff);
      bandDiffs[loadBand].push(diff);
      if (Number.isFinite(referenceUsed)) {
        analysisReferenceRows.push({
          legacy,
          si: siLoad,
          ref: referenceUsed
        });
      }

      if (typeof prevLegacy === "number" && typeof prevSi === "number") {
        const legacyDelta = legacy - prevLegacy;
        const siDelta = siLoad - prevSi;
        if (legacyDelta !== 0 && siDelta !== 0) {
          trendComparableCount += 1;
          if (Math.sign(legacyDelta) === Math.sign(siDelta)) {
            trendSameDirectionCount += 1;
          }
        }
      }
      prevLegacy = legacy;
      prevSi = siLoad;
    }

    sampleCount += 1;

    const sign = diff >= 0 ? "+" : "";
    const topText = Number.isFinite(topUsed) ? ` top=${fmt(topUsed)}%` : "";
    const winText = Number.isFinite(winUsed) ? ` win=${fmt(winUsed)}%` : "";
    const outlierText = isOutlier ? " outlier=YES" : "";
    const warmupText = isWarmup ? " phase=warmup" : ` band=${loadBand}`;
    console.log(`[${sampleCount}] ${ts} legacy=${legacy}% si=${siLoad}%${topText}${winText} diff=${sign}${diff}%${warmupText}${outlierText}`);
  }

  const summaryRows = [
    metricRow("Legacy os.cpus percentage", stats(legacyValues)),
    metricRow("Systeminformation currentLoad percentage", stats(siValues)),
    metricRow("Difference: systeminformation minus legacy", stats(diffValues))
  ];

  if (isMac) {
    summaryRows.push(metricRow("macOS top used percentage", stats(macTopValues)));
    summaryRows.push(metricRow("Difference: macOS top minus legacy", stats(diffTopLegacyValues)));
    summaryRows.push(metricRow("Difference: macOS top minus systeminformation", stats(diffTopSiValues)));
  }

  if (isWindows) {
    summaryRows.push(metricRow("Windows counter used percentage", stats(winPerfValues)));
    summaryRows.push(metricRow("Difference: Windows counter minus legacy", stats(diffWinLegacyValues)));
    summaryRows.push(metricRow("Difference: Windows counter minus systeminformation", stats(diffWinSiValues)));
  }

  printTable(
    "Summary Statistics",
    ["Metric", "Count", "Minimum", "Maximum", "Average", "Median", "90th Percentile"],
    summaryRows
  );

  const analysisRows = [
    metricRow("Legacy os.cpus percentage", stats(analysisLegacy)),
    metricRow("Systeminformation currentLoad percentage", stats(analysisSi)),
    metricRow("Difference: systeminformation minus legacy", stats(analysisDiffs)),
    metricRow("Difference at low load band", stats(bandDiffs.low)),
    metricRow("Difference at medium load band", stats(bandDiffs.medium)),
    metricRow("Difference at high load band", stats(bandDiffs.high))
  ];

  printTable(
    "Analysis Excluding Warmup",
    ["Metric", "Count", "Minimum", "Maximum", "Average", "Median", "90th Percentile"],
    analysisRows
  );

  printTable(
    "Load Band Definitions",
    ["Band", "Rule", "Metric Used"],
    [
      ["low", `currentLoad < ${loadBandThresholds.lowMax}%`, "systeminformation currentLoad"],
      [
        "medium",
        `currentLoad >= ${loadBandThresholds.lowMax}% and < ${loadBandThresholds.mediumMax}%`,
        "systeminformation currentLoad"
      ],
      ["high", `currentLoad >= ${loadBandThresholds.mediumMax}%`, "systeminformation currentLoad"]
    ]
  );

  const corr = correlation(analysisLegacy, analysisSi);
  const directionAgreement = trendComparableCount
    ? trendSameDirectionCount / trendComparableCount
    : NaN;
  const diffAvg = mean(analysisDiffs);
  const diffStd = stddev(analysisDiffs);

  printInterpretation({
    diffAvg,
    diffStd,
    corr,
    directionAgreement,
    outlierCount,
    sampleCount: analysisDiffs.length,
    warmupSamples,
    bandDiffs
  });

  printEvidenceAndConclusion(analysisReferenceRows, referenceInfo);

  console.log(`CSV saved: ${outputPath}`);
  console.log("Tip: Compare timestamps with Activity Monitor CPU Load graph while running a controlled workload.");
}

main().catch(error => {
  console.error("Failed:", error);
  process.exit(1);
});
