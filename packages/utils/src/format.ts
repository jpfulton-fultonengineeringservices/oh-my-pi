const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Format a duration in milliseconds to a short human-readable string.
 * Examples: "123ms", "1.5s", "30m15s", "2h30m", "3d2h"
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0ms";
	if (ms < SEC) return `${Math.floor(ms)}ms`;
	if (ms < MIN) {
		// Round to tenths first: `toFixed(1)` alone turns 59.95s+ into an impossible `60.0s`.
		const tenths = Math.round(ms / 100);
		return tenths < 600 ? `${(tenths / 10).toFixed(1)}s` : "1m";
	}
	if (ms < HOUR) {
		const mins = Math.floor(ms / MIN);
		const secs = Math.floor((ms % MIN) / SEC);
		return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
	}
	if (ms < DAY) {
		const hours = Math.floor(ms / HOUR);
		const mins = Math.floor((ms % HOUR) / MIN);
		return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
	}
	const days = Math.floor(ms / DAY);
	const hours = Math.floor((ms % DAY) / HOUR);
	return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

/**
 * Format a number with K/M/B suffix for compact display.
 * Uses 1 decimal for small leading digits when non-zero, rounded otherwise.
 * Values below 1,000 print as-is unless `maxFractionDigits` caps their decimals.
 * Examples: "999", "1K", "1.5K", "25K", "1M", "1.5M", "25M", "1.5B"
 */
export function formatNumber(n: number, maxFractionDigits?: number): string {
	if (n < 1_000) {
		if (maxFractionDigits === undefined || Number.isInteger(n)) return n.toString();
		return Number(n.toFixed(maxFractionDigits)).toString();
	}
	if (n < 10_000) return `${trim1(n / 1_000)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
	if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
	if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
	return `${Math.round(n / 1_000_000_000)}B`;
}

/** Format with up to 1 decimal place, dropping trailing `.0`. */
function trim1(n: number): string {
	const s = n.toFixed(1);
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** Fraction digits a USD amount at or above one dollar gets. */
const COST_DIGITS_DOLLAR = 2;
/** Fraction digits a USD amount below one dollar gets. */
const COST_DIGITS_SUB_DOLLAR = 3;
/** Fraction digits a USD amount below one cent starts from. */
const COST_DIGITS_SUB_CENT = 4;
/** Widest fraction {@link formatCost} uses to recover a sub-cent amount's digits. */
const COST_MAX_FRACTION_DIGITS = 8;

/**
 * Format a USD cost for display: `$1.50`, `$0.123`, `$0.00037`.
 *
 * The fraction width follows the magnitude — two digits at or above a dollar,
 * three below it, four below a cent — except that a sub-cent amount is widened
 * until it round-trips instead of rounding to `$0.0000`: gateway charges in this
 * ecosystem run 1e-6…1e-3, and a formatter that zeroes them makes a billed
 * request read as free. `maxFractionDigits` caps the width for callers with a
 * fixed column budget, which can put a tiny charge back to `$0.0000` — that
 * loss then belongs to the caller, not to the formatter. Non-finite input reads
 * as zero; negative amounts keep their sign.
 */
export function formatCost(cost: number, maxFractionDigits?: number): string {
	if (!Number.isFinite(cost) || cost === 0) return "$0.0000";
	const sign = cost < 0 ? "-" : "";
	const amount = Math.abs(cost);
	if (amount >= 1) return `${sign}$${amount.toFixed(COST_DIGITS_DOLLAR)}`;
	if (amount >= 0.01) return `${sign}$${amount.toFixed(COST_DIGITS_SUB_DOLLAR)}`;
	const cap = maxFractionDigits === undefined ? COST_MAX_FRACTION_DIGITS : Math.max(0, Math.floor(maxFractionDigits));
	let digits = Math.min(COST_DIGITS_SUB_CENT, cap);
	while (digits < cap && Number(amount.toFixed(digits)) !== amount) digits++;
	// Only a widened fraction is trimmed: a caller-chosen width stays fixed so
	// columns line up, and only the recovered digits are noise worth dropping.
	const text = digits > COST_DIGITS_SUB_CENT ? amount.toFixed(digits).replace(/0+$/, "") : amount.toFixed(digits);
	return `${sign}$${text}`;
}

/**
 * Format a byte count to a human-readable string.
 * Examples: "512B", "1.5KB", "2.3MB", "1.2GB"
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Count `\n` code units via native `indexOf` — no split array, roughly an
 * order of magnitude cheaper than a per-code-unit loop on multi-MiB text.
 * Line-count semantics are the caller's (empty text is 0 or 1 lines
 * depending on the contract).
 */
export function countNewlines(text: string): number {
	let count = 0;
	let pos = text.indexOf("\n");
	while (pos !== -1) {
		count++;
		pos = text.indexOf("\n", pos + 1);
	}
	return count;
}

/**
 * Truncate a string to maxLen characters, appending an ellipsis if truncated.
 * For display-width-aware truncation (terminals), use truncateToWidth from @oh-my-pi/pi-tui.
 */
export function truncate(str: string, maxLen: number, ellipsis = "…"): string {
	if (str.length <= maxLen) return str;
	const sliceLen = Math.max(0, maxLen - ellipsis.length);
	return `${str.slice(0, sliceLen)}${ellipsis}`;
}

/**
 * Collapse every whitespace run — spaces, tabs, newlines — to a single space and
 * trim the ends, so text from a child process, a model reply or a config value
 * can be dropped into one status row without spilling it over several visual
 * lines. Pair with `truncateToWidth` from `@oh-my-pi/pi-tui` when the row also
 * has a column budget: newlines are zero-width, so collapsing must happen first.
 */
export function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * Format count with pluralized label (e.g., "3 files", "1 error").
 */
export function formatCount(label: string, count: number): string {
	const safeCount = Number.isFinite(count) ? count : 0;
	return `${safeCount} ${pluralize(label, safeCount)}`;
}

/**
 * Format age from seconds to human-readable string.
 */
export function formatAge(ageSeconds: number | null | undefined): string {
	if (!ageSeconds) return "";
	const mins = Math.floor(ageSeconds / 60);
	const hours = Math.floor(mins / 60);
	const days = Math.floor(hours / 24);
	const weeks = Math.floor(days / 7);
	const months = Math.floor(days / 30);

	if (months > 0) return `${months}mo ago`;
	if (weeks > 0) return `${weeks}w ago`;
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (mins > 0) return `${mins}m ago`;
	return "just now";
}

/**
 * Pluralize a label based on the count.
 */
export function pluralize(label: string, count: number): string {
	if (count === 1) return label;
	if (/(?:ch|sh|s|x|z)$/i.test(label)) return `${label}es`;
	if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
	return `${label}s`;
}

/**
 * Format a ratio as a percentage.
 */
export function formatPercent(ratio: number): string {
	return `${(ratio * 100).toFixed(1)}%`;
}

/** Summary statistics over a rate series, as produced by the caller's own stats pass. */
export interface RateStats {
	readonly mean: number;
	readonly median: number;
	readonly min: number;
	readonly max: number;
	readonly stddev: number;
}

/**
 * Format a tokens-per-second rate: whole numbers at or above 100, one decimal
 * below, so a wide rate keeps a narrow column and a slow one still shows what
 * makes it slow. Anything unusable — negative, `NaN`, `Infinity` — reads `0`
 * rather than printing a signed or `NaN` measurement.
 */
export function formatRate(rate: number): string {
	if (!Number.isFinite(rate) || rate <= 0) return "0";
	// Round first, then pick the form: `toFixed(1)` alone turns 99.95+ into an
	// impossible `100.0`, the same trap formatDuration guards at the minute edge.
	const rounded = Number(rate.toFixed(1));
	return rounded >= 100 ? `${Math.round(rounded)}` : rounded.toFixed(1);
}

/**
 * One-line summary of a rate series: `med 44.1 · avg 52.3 · min 12.0 · max 210 · σ 18.4 tok/s`.
 *
 * `unit` labels the measurement; pass `""` for a unitless series. The separator
 * is a literal dot — a themed renderer substitutes `theme.sep.dot` when it paints
 * the row.
 */
export function formatRateStats(stats: RateStats, unit = "tok/s"): string {
	const label = unit === "" ? "" : ` ${unit}`;
	return (
		`med ${formatRate(stats.median)} · avg ${formatRate(stats.mean)} · ` +
		`min ${formatRate(stats.min)} · max ${formatRate(stats.max)} · ` +
		`σ ${formatRate(stats.stddev)}${label}`
	);
}

/** Round premium-request counters without losing legitimate fractional requests. */
export function normalizePremiumRequests(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}
