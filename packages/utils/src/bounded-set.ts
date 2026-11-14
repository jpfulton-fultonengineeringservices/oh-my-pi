/** Membership for a set of ids that must stay bounded and re-bindable. */

/** Options supported by {@link BoundedSet}. */
export interface BoundedSetOptions {
	/** Maximum retained members; `0` or omitted means unbounded. */
	max?: number;
}

/**
 * A `Set<string>` with a capacity, oldest-inserted eviction, and a {@link BoundedSet.rebind}
 * that re-places the whole set around one member.
 *
 * Between `LRUCache` (`@oh-my-pi/pi-utils/lru`) and `RingBuffer`
 * (`@oh-my-pi/pi-utils/ring`) — both reachable only by subpath — yet neither fits a
 * membership index that is consulted by `has` only. Recency is deliberately not
 * tracked — reading a
 * member never refreshes its position, so eviction order is insertion order and a
 * caller can reason about which id is dropped next. Iterate it with
 * `[Symbol.iterator]`; members come back oldest first.
 */
export class BoundedSet {
	#max: number;
	#values = new Set<string>();

	constructor(options: BoundedSetOptions = {}) {
		const max = options.max ?? 0;
		if (!Number.isInteger(max) || max < 0) throw new TypeError("max must be a non-negative integer");
		this.#max = max;
	}

	/** Register a member; ignores re-registrations, evicting the oldest to stay under capacity. */
	add(value: string): void {
		if (this.#values.has(value)) return;
		if (this.#max > 0 && this.#values.size >= this.#max) {
			const oldest = this.#values.values().next().value;
			if (oldest !== undefined) this.#values.delete(oldest);
		}
		this.#values.add(value);
	}

	/** True when `value` is a member; does not affect eviction order. */
	has(value: string): boolean {
		return this.#values.has(value);
	}

	/** Removes one member; returns whether it was present. */
	delete(value: string): boolean {
		return this.#values.delete(value);
	}

	/** Drop every member. */
	clear(): void {
		this.#values.clear();
	}

	/**
	 * Re-bind the set around a single member: everything registered before is
	 * dropped, so stale ids stop matching, and `value` becomes the only member.
	 */
	rebind(value: string): void {
		this.#values.clear();
		this.#values.add(value);
	}

	/** Number of retained members. */
	get size(): number {
		return this.#values.size;
	}

	/** Members, oldest inserted first. */
	*[Symbol.iterator](): IterableIterator<string> {
		yield* this.#values;
	}
}
