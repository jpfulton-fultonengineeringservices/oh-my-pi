import { describe, expect, it } from "bun:test";
import { BoundedSet } from "@oh-my-pi/pi-utils/bounded-set";

describe("BoundedSet", () => {
	it("evicts the oldest inserted member to stay under capacity", () => {
		const set = new BoundedSet({ max: 3 });
		for (const value of ["a", "b", "c", "d"]) set.add(value);
		expect(set.size).toBe(3);
		expect(set.has("a")).toBe(false);
		expect([...set]).toEqual(["b", "c", "d"]);
	});

	it("ignores a re-registration instead of counting or evicting it", () => {
		const set = new BoundedSet({ max: 3 });
		set.add("a");
		set.add("b");
		set.add("c");
		set.add("a");
		expect(set.size).toBe(3);
		expect([...set]).toEqual(["a", "b", "c"]);
	});

	it("keeps eviction on insertion order, not read order", () => {
		const set = new BoundedSet({ max: 2 });
		set.add("a");
		set.add("b");
		expect(set.has("a")).toBe(true);
		set.add("c");
		expect([...set]).toEqual(["b", "c"]);
	});

	it("is unbounded by default and at max 0", () => {
		const defaults = new BoundedSet();
		const zero = new BoundedSet({ max: 0 });
		for (const set of [defaults, zero]) {
			for (let index = 0; index < 5; index++) set.add(`id-${index}`);
			expect(set.size).toBe(5);
		}
	});

	it("re-binds the whole set around one member", () => {
		const set = new BoundedSet({ max: 3 });
		set.add("stale-1");
		set.add("stale-2");
		set.rebind("current");
		expect([...set]).toEqual(["current"]);
		expect(set.has("stale-1")).toBe(false);
	});

	it("deletes and clears", () => {
		const set = new BoundedSet({ max: 3 });
		set.add("a");
		expect(set.delete("a")).toBe(true);
		expect(set.delete("a")).toBe(false);
		set.add("b");
		set.clear();
		expect(set.size).toBe(0);
		expect([...set]).toEqual([]);
	});

	it("rejects a capacity that is not a non-negative integer", () => {
		expect(() => new BoundedSet({ max: -1 })).toThrow(new TypeError("max must be a non-negative integer"));
		expect(() => new BoundedSet({ max: 1.5 })).toThrow(new TypeError("max must be a non-negative integer"));
		expect(() => new BoundedSet({ max: Number.NaN })).toThrow(new TypeError("max must be a non-negative integer"));
	});
});
