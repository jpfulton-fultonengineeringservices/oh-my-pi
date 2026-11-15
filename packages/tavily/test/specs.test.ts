/**
 * The tool table.
 *
 * The config repo builds `pi.zod` argument schemas straight from this data, so
 * a mistake here becomes a model-facing schema defect there: a field that is a
 * function instead of a value cannot be validated at all, a missing `required`
 * silently makes a mandatory argument optional, and an accidental `engine` here
 * would duplicate the routing decision the config repo owns. These tests are
 * the guard rail for exactly that.
 */

import { describe, expect, it } from "bun:test";
import {
	TAVILY_TOOL_SPECS,
	buildCrawlBody,
	buildExtractBody,
	buildMapBody,
	buildResearchBody,
	buildResearchQueryParams,
	buildSearchBody,
	type TavilySpecField,
	type TavilyVerb,
} from "../src/index";

const FIELD_TYPES: ReadonlySet<string> = new Set([
	"string",
	"boolean",
	"number",
	"integer",
	"array",
	"object",
	"boolean|string",
]);

/** Transport-only, or owned by the caller: advertising one here invites a model to set it. */
const FORBIDDEN_FIELD_NAMES: ReadonlySet<string> = new Set([
	"engine",
	"apiKey",
	"signal",
	"timeoutSeconds",
	"apiBaseURL",
	"clientSource",
	"clientName",
	"adapter",
]);
const VERBS: readonly TavilyVerb[] = ["search", "extract", "crawl", "map", "research", "research_status"];

function fields(verb: TavilyVerb): Array<[string, TavilySpecField]> {
	return Object.entries(TAVILY_TOOL_SPECS[verb].fields);
}

function requiredFields(verb: TavilyVerb): string[] {
	return fields(verb)
		.filter(([, field]) => field.required === true)
		.map(([name]) => name);
}

/** A named failure beats "expected false to be true" when a table row is wrong. */
function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`spec check failed: ${message}`);
}

describe("TAVILY_TOOL_SPECS", () => {
	it("advertises exactly the six verbs, and nothing else", () => {
		expect(Object.keys(TAVILY_TOOL_SPECS).sort()).toEqual([...VERBS].sort());
	});

	it("gives every verb a description and at least one field", () => {
		for (const verb of VERBS) {
			expect(TAVILY_TOOL_SPECS[verb].description.trim().length).toBeGreaterThan(0);
			expect(fields(verb).length).toBeGreaterThan(0);
		}
	});

	it("is plain data: no function, symbol or undefined anywhere in it", () => {
		const walk = (value: unknown, path: string): void => {
			if (Array.isArray(value)) {
				value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
				return;
			}
			if (typeof value === "object" && value !== null) {
				for (const [key, entry] of Object.entries(value)) {
					assert(entry !== undefined, `${path}.${key} is undefined`);
					walk(entry, `${path}.${key}`);
				}
				return;
			}
			assert(!["function", "symbol", "undefined"].includes(typeof value), `${path} is a ${typeof value}`);
		};
		walk(TAVILY_TOOL_SPECS, "TAVILY_TOOL_SPECS");
	});

	it("declares a known type, a real description, and no contradictory bounds", () => {
		for (const verb of VERBS) {
			for (const [name, field] of fields(verb)) {
				const where = `${verb}.${name}`;
				assert(FIELD_TYPES.has(field.type), `${where}.type=${field.type}`);
				assert(field.description.trim().length > 0, `${where} has no description`);
				if (field.enum !== undefined) assert(field.enum.length > 0, `${where}.enum is empty`);
				if (field.type === "array") assert(field.items === "string", `${where}.items must be "string"`);
				if (field.minimum !== undefined && field.maximum !== undefined) {
					assert(field.minimum <= field.maximum, `${where} minimum exceeds maximum`);
				}
			}
		}
	});

	it("requires exactly the one argument each verb cannot do without", () => {
		expect(requiredFields("search")).toEqual(["query"]);
		expect(requiredFields("extract")).toEqual(["urls"]);
		expect(requiredFields("crawl")).toEqual(["url"]);
		expect(requiredFields("map")).toEqual(["url"]);
		expect(requiredFields("research")).toEqual(["input"]);
		expect(requiredFields("research_status")).toEqual(["requestId"]);
	});

	it("keeps transport-only and routing-only fields out of the model's reach", () => {
		for (const verb of VERBS) {
			for (const [name] of fields(verb)) {
				assert(!FORBIDDEN_FIELD_NAMES.has(name), `${verb}.${name} must not be advertised`);
			}
		}
	});
});

describe("per-verb surface", () => {
	it("search: depth, topic and recency enums, and a bounded maxResults", () => {
		const search = TAVILY_TOOL_SPECS.search.fields;
		expect(search.searchDepth?.enum).toEqual(["basic", "advanced", "fast", "ultra-fast"]);
		expect(search.topic?.enum).toEqual(["general", "news", "finance"]);
		expect(search.timeRange?.enum).toEqual(["year", "month", "week", "day", "y", "m", "w", "d"]);
		expect(search.maxResults).toMatchObject({ type: "integer", minimum: 0, maximum: 20 });
		expect(search.days?.type).toBe("integer");
		expect(search.includeDomains?.type).toBe("array");
		expect(search.includeAnswer?.type).toBe("boolean|string");
		expect(search.includeAnswer?.enum).toEqual([false, true, "basic", "advanced"]);
		expect(search.includeRawContent?.enum).toEqual([false, "markdown", "text"]);
	});

	it("extract: urls is a required string array and the format is an enum", () => {
		const extract = TAVILY_TOOL_SPECS.extract.fields;
		expect(extract.urls).toMatchObject({ type: "array", items: "string", required: true });
		expect(extract.format?.enum).toEqual(["markdown", "text"]);
		expect(extract.extractDepth?.enum).toEqual(["basic", "advanced"]);
		expect(extract.chunksPerSource).toMatchObject({ type: "integer", minimum: 1, maximum: 3 });
		expect(extract.query?.type).toBe("string");
	});

	it("crawl: bounded depth and the path/domain filters", () => {
		const crawl = TAVILY_TOOL_SPECS.crawl.fields;
		expect(crawl.maxDepth).toMatchObject({ type: "integer", minimum: 1, maximum: 5 });
		for (const name of ["selectPaths", "excludePaths", "selectDomains", "excludeDomains"]) {
			expect(crawl[name]?.type, name).toBe("array");
		}
		expect(crawl.allowExternal?.type).toBe("boolean");
		expect(crawl.instructions?.type).toBe("string");
	});

	it("map: filters without an extract format", () => {
		const map = TAVILY_TOOL_SPECS.map.fields;
		expect(map.url?.required).toBe(true);
		expect(map.limit?.type).toBe("integer");
		expect(map.allowExternal?.type).toBe("boolean");
		assert(map.format === undefined, "map must not advertise an extract format");
	});

	it("research: model choice, structured output, and citation formats", () => {
		const research = TAVILY_TOOL_SPECS.research.fields;
		expect(research.model?.enum).toEqual(["mini", "pro", "auto"]);
		expect(research.outputSchema?.type).toBe("object");
		expect(research.citationFormat?.enum).toEqual(["numbered", "mla", "apa", "chicago"]);
		expect(research.stream?.type).toBe("boolean");
	});

	it("research_status is a single id lookup", () => {
		expect(Object.keys(TAVILY_TOOL_SPECS.research_status.fields)).toEqual(["requestId", "includeUsage"]);
	});

	it("advertises usage reporting on the verbs that bill for it", () => {
		for (const verb of ["search", "extract", "crawl", "map", "research_status"] as const) {
			assert(TAVILY_TOOL_SPECS[verb].fields.includeUsage?.type === "boolean", `${verb} has no includeUsage`);
		}
	});
});

/** A value shaped enough for `project` to treat the field as set. */
function dummyValue(field: TavilySpecField): unknown {
	switch (field.type) {
		case "boolean":
		case "boolean|string":
			return true;
		case "number":
		case "integer":
			return 1;
		case "array":
			return ["x"];
		case "object":
			return { type: "object" };
		default:
			return "x";
	}
}

/**
 * Advertised, deliberately absent from the body: `timeout` on research is our HTTP
 * budget (the endpoint has no server-side one), and `requestId` travels in the
 * `GET /research/{id}` path rather than the query string.
 */
const CALLER_SIDE_FIELDS: Partial<Record<TavilyVerb, readonly string[]>> = {
	research: ["timeout"],
	research_status: ["requestId"],
};

type BodyBuilder = (params: Record<string, unknown>) => Record<string, unknown>;

/** The production builders, so the guard reads the same mapping the verbs use. */
const BODY_BUILDERS: Record<TavilyVerb, BodyBuilder> = {
	search: params => buildSearchBody(params as never),
	extract: params => buildExtractBody(params as never),
	crawl: params => buildCrawlBody(params as never),
	map: params => buildMapBody(params as never),
	research: params => buildResearchBody(params as never),
	research_status: params => buildResearchQueryParams(params as never),
};

/** Advertised fields that reach no wire key and are not caller-side budgets. */
function unwiredFields(verb: TavilyVerb, table = TAVILY_TOOL_SPECS[verb].fields): string[] {
	const build = BODY_BUILDERS[verb];
	const allowed = new Set(CALLER_SIDE_FIELDS[verb] ?? []);
	return Object.entries(table)
		.filter(([name, field]) => !allowed.has(name) && Object.keys(build({ [name]: dummyValue(field) })).length === 0)
		.map(([name]) => name);
}

describe("every advertised field is either on the wire or a caller-side budget", () => {
	it("finds nothing on the real table, and every verb puts at least one field on the wire", () => {
		for (const verb of VERBS) {
			expect(unwiredFields(verb), `${verb} advertises fields nothing consumes`).toEqual([]);
			const wired = fields(verb).filter(([name]) => !(CALLER_SIDE_FIELDS[verb] ?? []).includes(name));
			expect(wired.length, `${verb} reaches the wire with no field at all`).toBeGreaterThan(0);
		}
	});

	it("is not vacuous: a field nothing consumes is reported, and only that field", () => {
		const phantom: TavilySpecField = { type: "string", description: "consumed by nothing" };
		const table = { ...TAVILY_TOOL_SPECS.research.fields, phantomField: phantom };
		expect(unwiredFields("research", table)).toEqual(["phantomField"]);
	});

	it("keeps the research budget out of the body while honouring it as a timeout", () => {
		expect(Object.keys(buildResearchBody({ input: "x", timeout: 30 } as never))).toEqual(["input"]);
	});
});
