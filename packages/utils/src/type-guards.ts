export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reads an own string-valued property without invoking accessors. */
export function stringProperty(value: object, key: string): string | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/**
 * True for a string with at least one character. Whitespace-only text counts as
 * content — a value that merely has to be non-blank at the wire boundary is
 * still the caller's judgement to make.
 */
export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** True for a non-empty array whose every element is a non-empty string. */
export function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

/** True for an integer greater than zero; `NaN`, `Infinity` and fractions are not. */
export function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}
