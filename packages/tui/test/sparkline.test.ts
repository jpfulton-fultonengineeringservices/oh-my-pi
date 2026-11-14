import { describe, expect, it } from "bun:test";
import { renderSparkline } from "@oh-my-pi/pi-tui/components/sparkline";

describe("renderSparkline single series", () => {
	it("maps values onto the block ramp across the window domain", () => {
		expect(renderSparkline([0, 1, 2])).toBe("▁▅█");
	});

	it("never anchors the domain at zero when the window carries its own min and max", () => {
		expect(renderSparkline([500, 510], { min: 500, max: 510 })).toBe("▁█");
	});

	it("treats an undefined value as the gap, keeping the cells aligned", () => {
		expect(renderSparkline([2, undefined, 2], { gap: " " })).toBe("█ █");
		expect(renderSparkline([undefined, undefined])).toBe("  ");
	});

	it("keeps the legacy flat-window choice when flatFraction is omitted", () => {
		// Above the (default) min ⇒ full block, at or below it ⇒ lowest.
		expect(renderSparkline([5, 5], { min: 5, max: 5 })).toBe("▁▁");
		expect(renderSparkline([6, 6], { min: 5, max: 5 })).toBe("██");
	});

	it("draws flat windows from flatFraction instead of the legacy comparison", () => {
		expect(renderSparkline([5, 5, 5], { min: 5, max: 5, flatFraction: 0.5 })).toBe("▅▅▅");
		expect(renderSparkline([5, 5, 5], { min: 5, max: 5, flatFraction: 0 })).toBe("▁▁▁");
	});

	it("passes no series index to a single-series style", () => {
		const rendered = renderSparkline([0, 1], {
			style: (_glyph, _value, _fraction, series) => (series === undefined ? "u" : "d"),
		});
		expect(rendered).toBe("uu");
	});
});

describe("renderSparkline stacked series", () => {
	it("allocates each bucket's cells to the series that contributed them", () => {
		// Bucket one totals 2 of the window's 3 (five eighths of the ramp), bucket two the whole of it.
		expect(
			renderSparkline([], {
				series: [
					[1, 0],
					[1, 3],
				],
				cellsPerBucket: 2,
			}),
		).toBe("▆▆██");
	});

	it("ignores `values` once series are supplied", () => {
		expect(
			renderSparkline([999, 999], {
				series: [
					[1, 1],
					[1, 1],
				],
				cellsPerBucket: 2,
			}),
		).toBe(
			renderSparkline([], {
				series: [
					[1, 1],
					[1, 1],
				],
				cellsPerBucket: 2,
			}),
		);
	});

	it("reports which series a cell came from", () => {
		const rendered = renderSparkline([], {
			series: [[1], [2]],
			cellsPerBucket: 3,
			style: (_glyph, _value, _fraction, series) => String(series),
		});
		expect(rendered).toBe("011");
	});

	it("hands the bucket total, not the part, to the style", () => {
		const seen: number[] = [];
		renderSparkline([], { series: [[1], [2]], cellsPerBucket: 2, style: (_g, value) => `${seen.push(value)}` });
		expect(seen).toEqual([3, 3]);
	});

	it("keeps a zero-total bucket as a gap of cellsPerBucket cells", () => {
		expect(
			renderSparkline([], {
				series: [
					[0, 1],
					[0, 1],
				],
				cellsPerBucket: 2,
				gap: " ",
			}),
		).toBe("  ██");
	});

	it("treats an undefined cell as zero for its bucket total", () => {
		expect(
			renderSparkline([], {
				series: [
					[undefined, 1],
					[undefined, 1],
				],
				cellsPerBucket: 1,
			}),
		).toBe(
			renderSparkline([], {
				series: [
					[0, 1],
					[0, 1],
				],
				cellsPerBucket: 1,
			}),
		);
	});

	it("clamps the cell allocation to cellsPerBucket when rounding would overflow it", () => {
		// Three series of 1 each in 2 cells: two series get a cell, one gets none.
		expect(renderSparkline([], { series: [[1], [1], [1]], cellsPerBucket: 2 })).toBe("██");
	});

	it("floors cellsPerBucket at one", () => {
		expect(renderSparkline([], { series: [[3]], cellsPerBucket: 0 })).toBe("█");
	});

	it("renders nothing for an empty series row, and falls back to values when there are no rows", () => {
		expect(renderSparkline([], { series: [[]] })).toBe("");
		expect(renderSparkline([1, 2], { series: [] })).toBe("▅█");
	});
});
