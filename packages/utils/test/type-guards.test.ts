import { describe, expect, it } from "bun:test";
import { isNonEmptyString, isNonEmptyStringArray, isPositiveInteger } from "@oh-my-pi/pi-utils/type-guards";

describe("isNonEmptyString", () => {
	it("narrows a string-typed value with content", () => {
		const candidate: unknown = "codekeeper";
		expect(isNonEmptyString(candidate)).toBe(true);
		if (isNonEmptyString(candidate)) expect(candidate.length).toBe(10);
	});

	it("rejects the empty string but keeps whitespace-only content", () => {
		expect(isNonEmptyString("")).toBe(false);
		expect(isNonEmptyString(" ")).toBe(true);
	});

	it("rejects non-strings", () => {
		for (const candidate of [5, null, undefined, {}, [], true]) {
			expect(isNonEmptyString(candidate)).toBe(false);
		}
	});
});

describe("isNonEmptyStringArray", () => {
	it("accepts an array whose every element is a non-empty string", () => {
		const candidate: unknown = ["codekeeper", "memvid"];
		expect(isNonEmptyStringArray(candidate)).toBe(true);
		if (isNonEmptyStringArray(candidate)) expect(candidate[1]).toBe("memvid");
	});

	it("rejects the empty array", () => {
		expect(isNonEmptyStringArray([])).toBe(false);
	});

	it("rejects an array containing an empty string or a non-string", () => {
		expect(isNonEmptyStringArray(["codekeeper", ""])).toBe(false);
		expect(isNonEmptyStringArray(["codekeeper", 3])).toBe(false);
		expect(isNonEmptyStringArray(["codekeeper", null])).toBe(false);
	});

	it("rejects a bare string", () => {
		expect(isNonEmptyStringArray("codekeeper")).toBe(false);
	});
});

describe("isPositiveInteger", () => {
	it("accepts integers above zero", () => {
		expect(isPositiveInteger(1)).toBe(true);
		expect(isPositiveInteger(32768)).toBe(true);
	});

	it("rejects zero, negatives, fractions and non-finite numbers", () => {
		expect(isPositiveInteger(0)).toBe(false);
		expect(isPositiveInteger(-1)).toBe(false);
		expect(isPositiveInteger(1.5)).toBe(false);
		expect(isPositiveInteger(Number.NaN)).toBe(false);
		expect(isPositiveInteger(Number.POSITIVE_INFINITY)).toBe(false);
	});

	it("rejects numeric strings", () => {
		expect(isPositiveInteger("3")).toBe(false);
	});
});
