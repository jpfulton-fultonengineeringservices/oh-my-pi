import { describe, expect, it } from "bun:test";
import { formatCost, formatDuration, formatRate, formatRateStats, oneLine } from "@oh-my-pi/pi-utils/format";

describe("formatDuration", () => {
	// Codex's wham/usage endpoint returns the prior window's reset_at until the
	// next request opens a fresh window, so the `resetsAt - now` delta can land
	// in the recent past. The util must defend against that — older builds
	// rendered "-612090ms", which leaked straight into the /usage TUI.
	it("clamps non-positive, NaN, and Infinity inputs to 0ms", () => {
		expect(formatDuration(-612_090)).toBe("0ms");
		expect(formatDuration(-1)).toBe("0ms");
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(Number.NaN)).toBe("0ms");
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
		expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe("0ms");
	});

	it("formats sub-second, sub-minute, sub-hour, sub-day, and multi-day ranges", () => {
		expect(formatDuration(500)).toBe("500ms");
		expect(formatDuration(289.99999999999994)).toBe("289ms");
		expect(formatDuration(1_500)).toBe("1.5s");
		expect(formatDuration(90_000)).toBe("1m30s");
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(3_660_000)).toBe("1h1m");
		expect(formatDuration(2 * 86_400_000 + 3_600_000)).toBe("2d1h");
	});

	it("never prints a 60-second remainder at the minute boundary", () => {
		expect(formatDuration(59_940)).toBe("59.9s");
		expect(formatDuration(59_960)).toBe("1m");
		expect(formatDuration(119_600)).toBe("1m59s");
	});
});

describe("formatCost", () => {
	it("keeps gateway charges a fixed 4-decimal floor loses", () => {
		// `$${amount.toFixed(4)}` rendered 1.2e-6 as "$0.0000" and rounded 0.00037 away.
		expect(formatCost(0.00037)).toBe("$0.00037");
		expect(formatCost(1.2e-6)).toBe("$0.0000012");
	});

	it("keeps the band tiers and their digit counts", () => {
		expect(formatCost(0.0123)).toBe("$0.012");
		expect(formatCost(0.5)).toBe("$0.500");
		expect(formatCost(1.5)).toBe("$1.50");
		expect(formatCost(1234.567)).toBe("$1234.57");
	});

	it("renders zero and non-finite input as $0.0000", () => {
		expect(formatCost(0)).toBe("$0.0000");
		expect(formatCost(Number.NaN)).toBe("$0.0000");
		expect(formatCost(Number.POSITIVE_INFINITY)).toBe("$0.0000");
		expect(formatCost(Number.NEGATIVE_INFINITY)).toBe("$0.0000");
	});

	it("negates without losing precision", () => {
		expect(formatCost(-0.00025)).toBe("-$0.00025");
		expect(formatCost(-2.5)).toBe("-$2.50");
	});

	it("honours maxFractionDigits as the precision ceiling", () => {
		expect(formatCost(0.00037, 4)).toBe("$0.0004");
		expect(formatCost(0.00037, 6)).toBe("$0.00037");
		expect(formatCost(1.5, 2)).toBe("$1.50");
	});

	it("keeps the fixed width when a charge is below the precision cap", () => {
		// 8 digits is the default cap. Below 1e-8 the widening recovers no digit
		// at all, and stripping the whole fraction would print "$0.".
		expect(formatCost(1e-9)).toBe("$0.00000000");
		expect(formatCost(1e-8)).toBe("$0.00000001");
		expect(formatCost(1e-9, 6)).toBe("$0.000000");
	});
});

describe("formatRate", () => {
	it("keeps one decimal below 100 and rounds above it", () => {
		expect(formatRate(44.06)).toBe("44.1");
		expect(formatRate(123.4)).toBe("123");
	});

	it("never prints an impossible one-decimal value at the 100 boundary", () => {
		expect(formatRate(99.96)).toBe("100");
	});

	it("renders zero, negative and non-finite rates as 0", () => {
		expect(formatRate(0)).toBe("0");
		expect(formatRate(-3.2)).toBe("0");
		expect(formatRate(Number.NaN)).toBe("0");
		expect(formatRate(Number.POSITIVE_INFINITY)).toBe("0");
		expect(formatRate(Number.NEGATIVE_INFINITY)).toBe("0");
	});
});

describe("formatRateStats", () => {
	const stats = { mean: 41.2, median: 44.1, min: 3.4, max: 123.4, stddev: 12.5 };

	it("renders the spread in med/avg/min/max/σ order with the unit", () => {
		expect(formatRateStats(stats)).toBe("med 44.1 · avg 41.2 · min 3.4 · max 123 · σ 12.5 tok/s");
	});

	it("drops the unit label when passed an empty one", () => {
		expect(formatRateStats(stats, "")).toBe("med 44.1 · avg 41.2 · min 3.4 · max 123 · σ 12.5");
	});
});

describe("oneLine", () => {
	it("collapses every whitespace run, tabs and newlines included, and trims", () => {
		expect(oneLine("a\n\tb   c ")).toBe("a b c");
		expect(oneLine("  \n\t  ")).toBe("");
	});

	it("leaves an already-single-line string untouched", () => {
		expect(oneLine("keep me")).toBe("keep me");
	});
});
