import { readFileSync } from 'node:fs';

/**
 * Latency percentiles and cgroup memory sampling.
 *
 * Percentiles are exact: every latency is kept and sorted, which at a few
 * tens of thousands of samples is cheaper than getting an HDR histogram's
 * bucket boundaries right by hand.
 */

export interface Sample {
  endpoint: string;
  ms: number;
  /** HTTP status, or 0 for a transport error / timeout. */
  status: number;
  ok: boolean;
  /** Relative to the start of the measured window. */
  at: number;
}

export interface EndpointSummary {
  endpoint: string;
  count: number;
  errors: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  rps: number;
  statuses: Record<string, number>;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  // Nearest-rank, which is what k6 and autocannon report.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarise(samples: Sample[], endpoint: string, seconds: number): EndpointSummary {
  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => !s.ok).length;
  const statuses: Record<string, number> = {};
  for (const s of samples) statuses[String(s.status)] = (statuses[String(s.status)] ?? 0) + 1;
  return {
    endpoint,
    count: samples.length,
    errors,
    errorRate: samples.length === 0 ? 0 : errors / samples.length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.at(-1) ?? Number.NaN,
    mean: latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length),
    rps: samples.length / seconds,
    statuses,
  };
}

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

export interface MemoryReading {
  /** `memory.current`: what the limit is enforced against, page cache included. */
  current: number;
  /** `memory.current − inactive_file`: the number `docker stats` shows. */
  workingSet: number;
  /** Anonymous memory: heap, stacks, private mappings — the closest thing to RSS. */
  anon: number;
  /** `memory.peak`: the high-water mark since the cgroup was created. */
  peak: number;
}

export function readCgroup(dir: string): MemoryReading | null {
  try {
    const current = Number(readFileSync(`${dir}/memory.current`, 'utf8').trim());
    let peak = Number.NaN;
    try {
      peak = Number(readFileSync(`${dir}/memory.peak`, 'utf8').trim());
    } catch {
      // older kernels have no memory.peak
    }
    const stat = Object.fromEntries(
      readFileSync(`${dir}/memory.stat`, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const [key, value] = line.split(' ');
          return [key!, Number(value)];
        }),
    );
    return {
      current,
      workingSet: current - (stat.inactive_file ?? 0),
      anon: stat.anon ?? 0,
      peak,
    };
  } catch {
    return null;
  }
}

export interface MemorySeries {
  service: string;
  limitMiB: number;
  readings: { at: number; reading: MemoryReading }[];
}

export interface MemorySummary {
  service: string;
  limitMiB: number;
  samples: number;
  steadyWorkingSetMiB: number;
  peakWorkingSetMiB: number;
  steadyAnonMiB: number;
  peakAnonMiB: number;
  peakCurrentMiB: number;
  /** `memory.peak` at the end of the run — includes start-up and seeding. */
  cgroupPeakMiB: number;
}

const MiB = 1024 * 1024;

export function summariseMemory(series: MemorySeries): MemorySummary {
  const r = series.readings.map((x) => x.reading);
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? Number.NaN;
  };
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : Number.NaN);
  return {
    service: series.service,
    limitMiB: series.limitMiB,
    samples: r.length,
    steadyWorkingSetMiB: median(r.map((x) => x.workingSet)) / MiB,
    peakWorkingSetMiB: max(r.map((x) => x.workingSet)) / MiB,
    steadyAnonMiB: median(r.map((x) => x.anon)) / MiB,
    peakAnonMiB: max(r.map((x) => x.anon)) / MiB,
    peakCurrentMiB: max(r.map((x) => x.current)) / MiB,
    cgroupPeakMiB: (r.at(-1)?.peak ?? Number.NaN) / MiB,
  };
}

export function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}
