/**
 * One-row block sparklines (`▁▂▃▅▇█`) for ANSI renderers: the usage history
 * in `omp usage`, a job widget's series in the `wait` card and status line.
 */

/** Block glyphs from lowest to highest. */
export const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** One stacked-sparkline row: one value per time bucket, oldest bucket first. */
export type SparklineSeries = readonly (number | undefined)[];

/** How {@link renderSparkline} maps values to glyphs and styles them. */
export interface SparklineOptions {
	/** Domain low end; values at or below it draw the lowest block. Default 0. */
	readonly min?: number;
	/** Domain high end; values at or above it draw the full block. Default the largest value. */
	readonly max?: number;
	/**
	 * Styles one glyph; `fraction` is the value's 0–1 position in the domain and
	 * `series` is the stacked row that owns the cell, `undefined` when not stacked.
	 */
	readonly style?: (glyph: string, value: number, fraction: number, series?: number) => string;
	/** What a missing value draws, already styled. Default a space. */
	readonly gap?: string;
	/**
	 * Stacked mode: one row per series, each row one value per time bucket, oldest
	 * bucket first. Every cell of a bucket carries that bucket's height, so the
	 * `series` index handed to `style` — not the glyph — is what varies across a
	 * bucket's cells. A bucket's total is the sum of its column and is what `min`
	 * and `max` scale, exactly as a plain value is scaled; `values` is then unused,
	 * so pass `[]`. A bucket whose total is not positive draws `gap`.
	 */
	readonly series?: readonly SparklineSeries[];
	/** Stacked mode: cells each bucket occupies, floored at 1. Default 1. */
	readonly cellsPerBucket?: number;
	/**
	 * Fraction drawn when the drawn domain has no span — one sample, or every sample
	 * equal. Default keeps the legacy mapping (full block above `min`, lowest block
	 * at it). Pass `0.5` to draw a *flat but real* series as a mid-ramp band, which
	 * is what keeps `gap` free to mean "no data": a flat band is an idle feed, a gap
	 * is a dead one, and collapsing the two makes them indistinguishable.
	 */
	readonly flatFraction?: number;
}

/** The block glyph for a 0–1 fraction of the domain. */
export function sparkGlyph(fraction: number): string {
	const clamped = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
	return SPARK_LEVELS[Math.min(SPARK_LEVELS.length - 1, Math.floor(clamped * SPARK_LEVELS.length))]!;
}

/** One cell per value, oldest first; `undefined` (and non-finite) values draw the gap. */
export function renderSparkline(values: readonly (number | undefined)[], options: SparklineOptions = {}): string {
	const gap = options.gap ?? " ";
	const series = options.series;
	if (series !== undefined && series.length > 0) return renderStackedSparkline(series, gap, options);
	const min = options.min ?? 0;
	let max = options.max;
	if (max === undefined) {
		max = min;
		for (const value of values) if (value !== undefined && Number.isFinite(value) && value > max) max = value;
	}
	const span = max - min;
	let out = "";
	for (const value of values) {
		if (value === undefined || !Number.isFinite(value)) {
			out += gap;
			continue;
		}
		const fraction = span > 0 ? (value - min) / span : (options.flatFraction ?? (value > min ? 1 : 0));
		const glyph = sparkGlyph(fraction);
		out += options.style ? options.style(glyph, value, Math.min(Math.max(fraction, 0), 1), undefined) : glyph;
	}
	return out;
}

/**
 * Allocate `cells` across `parts` by share of their total: floors first, then the
 * remaining cells to the largest fractional parts, ties to the earlier part, so the
 * allocation always sums to exactly `cells`. A positive part can still get 0 cells
 * when there are more parts than cells, so callers must not assume a non-zero part
 * is necessarily visible.
 */
function allocateCells(parts: readonly number[], cells: number): number[] {
	const magnitudes = parts.map(part => (Number.isFinite(part) && part > 0 ? part : 0));
	const allocation = magnitudes.map(() => 0);
	const total = magnitudes.reduce((sum, part) => sum + part, 0);
	if (cells <= 0 || total <= 0) return allocation;
	const exact = magnitudes.map(part => (part / total) * cells);
	let remaining = cells;
	for (let index = 0; index < exact.length; index++) {
		const whole = Math.floor(exact[index]!);
		allocation[index] = whole;
		remaining -= whole;
	}
	const byRemainder = exact
		.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
		.sort((a, b) => (b.fraction === a.fraction ? a.index - b.index : b.fraction - a.fraction));
	for (const { index } of byRemainder) {
		if (remaining <= 0) break;
		allocation[index] = (allocation[index] ?? 0) + 1;
		remaining -= 1;
	}
	return allocation;
}

/** Stacked branch of {@link renderSparkline}: the bucket sets the height, the series the colour. */
function renderStackedSparkline(series: readonly SparklineSeries[], gap: string, options: SparklineOptions): string {
	const cellsPerBucket = Math.max(1, Math.floor(options.cellsPerBucket ?? 1));
	let buckets = 0;
	for (const row of series) buckets = Math.max(buckets, row.length);
	if (buckets === 0) return "";
	const totals: number[] = [];
	for (let bucket = 0; bucket < buckets; bucket++) {
		let total = 0;
		for (const row of series) {
			const value = row[bucket];
			if (value !== undefined && Number.isFinite(value)) total += value;
		}
		totals.push(total);
	}
	const min = options.min ?? 0;
	let max = options.max;
	if (max === undefined) {
		max = min;
		for (const total of totals) if (total > max) max = total;
	}
	const span = max - min;
	let out = "";
	for (let bucket = 0; bucket < buckets; bucket++) {
		const total = totals[bucket]!;
		// A bucket with nothing in it keeps its cells so time stays aligned.
		if (total <= 0) {
			out += gap.repeat(cellsPerBucket);
			continue;
		}
		const row = series.map(values => values[bucket] ?? Number.NaN);
		const fraction = span > 0 ? (total - min) / span : (options.flatFraction ?? (total > min ? 1 : 0));
		const glyph = sparkGlyph(fraction);
		const clamped = Math.min(Math.max(fraction, 0), 1);
		const allocation = allocateCells(row, cellsPerBucket);
		for (let index = 0; index < allocation.length; index++) {
			const count = allocation[index] ?? 0;
			if (count <= 0) continue;
			out += (options.style ? options.style(glyph, total, clamped, index) : glyph).repeat(count);
		}
	}
	return out;
}

/**
 * `values` squeezed into at most `cells` points by equal-count bucket means,
 * newest bucket last; shorter series come back unchanged.
 */
export function fitSparkValues(values: readonly number[], cells: number): readonly number[] {
	const count = Math.max(0, Math.floor(cells));
	if (values.length <= count) return values;
	const out: number[] = [];
	for (let bucket = 0; bucket < count; bucket++) {
		const from = Math.floor((bucket * values.length) / count);
		const to = Math.max(from + 1, Math.floor(((bucket + 1) * values.length) / count));
		let sum = 0;
		for (let i = from; i < to; i++) sum += values[i]!;
		out.push(sum / (to - from));
	}
	return out;
}

/**
 * The largest value per time bucket over `[sinceMs, nowMs]`, `cells` buckets
 * wide; buckets without a point are `undefined` (a gap in the sparkline).
 */
export function peakBuckets(
	points: Iterable<{ readonly at: number; readonly value: number }>,
	sinceMs: number,
	nowMs: number,
	cells: number,
): (number | undefined)[] {
	const span = Math.max(1, nowMs - sinceMs);
	const count = Math.max(0, Math.floor(cells));
	const buckets: (number | undefined)[] = Array.from({ length: count }, () => undefined);
	if (count === 0) return buckets;
	for (const point of points) {
		const offset = Math.floor(((point.at - sinceMs) / span) * count);
		const index = Math.min(count - 1, Math.max(0, offset));
		const prev = buckets[index];
		buckets[index] = prev === undefined ? point.value : Math.max(prev, point.value);
	}
	return buckets;
}
