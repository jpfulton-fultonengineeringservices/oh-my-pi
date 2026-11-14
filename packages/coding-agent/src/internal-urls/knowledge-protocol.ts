import knowledgeDoc from "../prompts/internal-urls/knowledge.md" with { type: "text" };
import { asRecord, sanitizeText, stringProperty } from "@oh-my-pi/pi-utils";
import {
	replaceTabs,
	sanitizeDisplayLines,
	shortenEmbeddedPaths,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { withTimeoutSignal } from "../utils/fetch-timeout";
import { loadMemvidkb, loadMemvidkbConfig } from "./knowledge-config";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, SchemeHost, SchemeSpec } from "./types";

/** A knowledge read is one small GET; a wedged service must not wedge the read tool. */
const KNOWLEDGE_TIMEOUT_MS = 10_000;
/** Bound on how much of a service error body is read at all; rendering clips to {@link TRUNCATE_LENGTHS}. */
const MAX_SERVICE_DETAIL_CHARS = 500;

/** Provenance carried on a record, in display order: service field, header label, note key. */
const PROVENANCE_FIELDS: ReadonlyArray<{ json: string; header: string; note: string }> = [
	{ json: "originActor", header: "origin", note: "origin" },
	{ json: "capturedAt", header: "captured", note: "captured" },
	{ json: "lastVerifiedAt", header: "verified", note: "verified_at" },
	{ json: "derivedFrom", header: "derived_from", note: "derived_from" },
	{ json: "supersededBy", header: "superseded_by", note: "superseded_by" },
];

interface KnowledgeTarget {
	kind: "record" | "track";
	contextName: string;
	track: string;
	recordId: string;
}

/**
 * Resolves `knowledge://record/<context>/<track>/<record-id>` and
 * `knowledge://track/<context>/<track>` against the memvid-kb-rs service.
 *
 * Consent boundary: the workspace's `.memvidkb` decides which context and which
 * tracks this session may read, and both are checked **before** any network call,
 * so a guessed URI for an out-of-scope resource fails without touching the
 * service. Every refusal and every outage is a non-empty explanation with the
 * specific `notes` code — an outage is never reported as zero results.
 */
export class KnowledgeProtocolHandler implements ProtocolHandler {
	readonly scheme = "knowledge";
	readonly spec: SchemeSpec = {
		backing: "remote",
		selectors: "lines",
		immutable: true,
	};

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (context?.signal?.aborted) throw new Error("aborted");

		const target = parseKnowledgeTarget(url);
		if (!target) {
			return refusal(
				url,
				"Invalid knowledge URI; expected knowledge://record/<context>/<track>/<document> or knowledge://track/<context>/<track>.",
				["invalid_knowledge_uri"],
			);
		}

		const loaded = await loadMemvidkbConfig(context?.cwd ?? process.cwd());
		if ("err" in loaded) {
			return refusal(url, `Knowledge is unavailable: ${loaded.err.msg}.`, [loaded.err.code]);
		}
		const config = loaded.ok;

		if (target.contextName !== config.context) {
			return refusal(
				url,
				`Knowledge context "${target.contextName}" is not the context this workspace is bound to ("${config.context}"). Reads across contexts are refused; re-issue the URI under the bound context or bind this workspace to the other context in .memvidkb.`,
				["context_mismatch"],
			);
		}
		if (!config.tracks.includes(target.track)) {
			const permitted = config.tracks.length > 0 ? config.tracks.join(", ") : "none configured";
			return refusal(
				url,
				`Track "${target.track}" is not permitted for context "${config.context}" (permitted tracks: ${permitted}). Ask the operator to add it to .memvidkb.`,
				["track_not_permitted"],
			);
		}

		const token = process.env[config.tokenEnvVar];
		if (!token) {
			return refusal(
				url,
				`Knowledge is unavailable: bearer token env var "${config.tokenEnvVar}" is unset or empty. Unauthenticated reads are never attempted.`,
				["TOKEN_ENV_UNSET"],
			);
		}

		const endpoint = knowledgeEndpoint(config.baseUrl, target);
		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "GET",
				headers: { accept: "application/json", authorization: `Bearer ${token}` },
				signal: withTimeoutSignal(KNOWLEDGE_TIMEOUT_MS, context?.signal),
			});
		} catch (error) {
			if (context?.signal?.aborted) throw new Error("aborted");
			const detail = error instanceof Error ? error.message : String(error);
			return refusal(
				url,
				`Knowledge service at ${endpoint} is unreachable (${detail}); the record could not be retrieved. This is an outage, not an empty result set.`,
				["service_unavailable"],
			);
		}

		if (!response.ok) {
			const detail = await serviceDetail(response);
			return refusal(url, serviceFailureText(response.status, target, endpoint, detail), [
				noteForStatus(response.status),
			]);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			if (context?.signal?.aborted) throw new Error("aborted");
			const detail = error instanceof Error ? error.message : String(error);
			return refusal(
				url,
				`Knowledge service at ${endpoint} answered with a body that is not JSON (${detail}); no content is available. This is an outage, not an empty result set.`,
				["service_unavailable"],
			);
		}

		return target.kind === "record" ? renderRecord(url, target, payload) : renderTrack(url, target, payload);
	}

	/**
	 * Advertised only when this workspace has a usable `.memvidkb` and its bearer is set.
	 * `workspace` pins the directory the upward search starts from, so a caller that knows
	 * the session's working directory can ask about it without the process changing cwd.
	 */
	promptDoc(_host?: SchemeHost, workspace: string = process.cwd()): string | undefined {
		const loaded = loadMemvidkb(workspace);
		return "ok" in loaded ? knowledgeDoc.trim() : undefined;
	}
}

/** Keep the validator's "never drop the context" rule: every segment must be one clean path segment. */
function parseKnowledgeTarget(url: InternalUrl): KnowledgeTarget | undefined {
	const kind = url.rawHost || url.hostname;
	if (kind !== "record" && kind !== "track") return undefined;

	const segments = (url.rawPathname ?? url.pathname).split("/").slice(1);
	const expected = kind === "record" ? 3 : 2;
	if (segments.length !== expected) return undefined;

	const decoded: string[] = [];
	for (const segment of segments) {
		let value: string;
		try {
			value = decodeURIComponent(segment);
		} catch {
			return undefined;
		}
		if (value.length === 0 || value.includes("/") || value.includes("\\")) return undefined;
		decoded.push(value);
	}

	const [contextName, track] = decoded;
	if (contextName === undefined || track === undefined) return undefined;
	const recordId = kind === "record" ? (decoded[2] ?? "") : "";
	if (kind === "record" && recordId.length === 0) return undefined;
	return { kind, contextName, track, recordId };
}

function knowledgeEndpoint(baseUrl: string, target: KnowledgeTarget): string {
	const origin = baseUrl.replace(/\/+$/, "");
	const track = encodeURIComponent(target.track);
	if (target.kind === "track") return `${origin}/memories/${track}/records`;
	return `${origin}/memories/${track}/records/${encodeURIComponent(target.recordId)}`;
}

/** Never zero results for an outage: every failure path carries an explanation and a code. */
function refusal(url: InternalUrl, content: string, notes: string[]): InternalResource {
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		shape: "document",
		notes,
	};
}

function noteForStatus(status: number): string {
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 404) return "not_found";
	return "service_unavailable";
}

function serviceFailureText(status: number, target: KnowledgeTarget, endpoint: string, detail: string): string {
	const subject = target.kind === "record" ? `record "${target.recordId}"` : `track "${target.track}"`;
	const suffix = detail.length > 0 ? ` The service said: ${detail}` : "";
	if (status === 401) {
		return `Knowledge service at ${endpoint} rejected the bearer token, so ${subject} could not be read. This is an outage, not an empty result set.${suffix}`;
	}
	if (status === 403) {
		return `Knowledge service at ${endpoint} refused ${subject} for this context's policy. The content was not disclosed. This is a refusal, not an empty result set.${suffix}`;
	}
	if (status === 404) {
		return `Knowledge service at ${endpoint} has no ${subject}. Nothing was found for this exact address.${suffix}`;
	}
	return `Knowledge service at ${endpoint} answered ${status} for ${subject}, so it is unavailable. This is an outage, not an empty result set.${suffix}`;
}

/** Truncated service detail, with the bearer never included. */
async function serviceDetail(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_SERVICE_DETAIL_CHARS) return "";
	let body: string;
	try {
		body = await response.text();
	} catch {
		return "";
	}
	const clipped = body.slice(0, MAX_SERVICE_DETAIL_CHARS);
	const message = serviceErrorMessage(clipped);
	return truncateToWidth(replaceTabs(shortenEmbeddedPaths(oneLine(message ?? clipped))), TRUNCATE_LENGTHS.LONG);
}

function serviceErrorMessage(body: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const error = (parsed as Record<string, unknown>).error;
		if (typeof error !== "object" || error === null) return undefined;
		const message = (error as Record<string, unknown>).message;
		return typeof message === "string" ? message : undefined;
	} catch {
		return undefined;
	}
}

function renderRecord(url: InternalUrl, target: KnowledgeTarget, payload: unknown): InternalResource {
	const record = asRecord(payload);
	const text = record ? stringProperty(record, "text") : undefined;
	if (!record || !text) {
		return refusal(
			url,
			"Knowledge service returned a record body without text; no content is available. This is an outage, not an empty result set.",
			["service_unavailable"],
		);
	}

	const id = renderedProperty(record, "id") ?? target.recordId;
	const track = renderedProperty(record, "track") ?? target.track;
	const title = renderedProperty(record, "title");
	const successor = renderedProperty(record, "supersededBy");

	const header: string[] = [`# ${title ?? id}`, ""];
	if (successor !== undefined) {
		// The trail is preserved deliberately, so a prior has to say for itself that it is
		// the superseded text instead of letting its body read as the answer.
		header.push(
			`> **Superseded by \`${successor}\`** — read \`knowledge://record/${target.contextName}/${track}/${successor}\` for the current answer; the text below is the prior, preserved deliberately.`,
			"",
		);
	}
	header.push(`- id: ${id}`, `- track: ${track}`);
	const notes: string[] = [];
	for (const field of PROVENANCE_FIELDS) {
		const value = stringProperty(record, field.json);
		if (!value) continue;
		header.push(`- ${field.header}: ${renderedLine(value)}`);
		notes.push(`${field.note}=${value}`);
	}
	header.push("");

	return {
		url: url.href,
		content: `${header.join("\n")}\n${sanitizeDisplayLines(text).join("\n")}`,
		contentType: "text/markdown",
		shape: "document",
		notes,
	};
}

function renderTrack(url: InternalUrl, target: KnowledgeTarget, payload: unknown): InternalResource {
	const listing = asRecord(payload);
	const results = Array.isArray(listing?.results) ? listing.results : undefined;
	if (!listing || !results) {
		return refusal(
			url,
			"Knowledge service returned a track listing body without a results array; no content is available. This is an outage, not an empty result set.",
			["service_unavailable"],
		);
	}

	// `total` is contract-required in the listing body. When the service omits it, the page
	// is all the reader has, so no claim about the whole track may be drawn from it.
	const reportedTotal = typeof listing.total === "number" ? listing.total : undefined;
	const total = reportedTotal ?? results.length;
	const lines: string[] = [`# Track ${target.track}`, ""];
	if (results.length === 0) {
		lines.push(`Track "${target.track}" holds no records (total ${total}). Nothing here is an outage.`);
	} else {
		const entries: string[] = [];
		let superseded = 0;
		for (const item of results) {
			const entry = asRecord(item);
			const id = renderedProperty(entry, "id") ?? "(unknown id)";
			const title = renderedProperty(entry, "title");
			// The service keeps corrected priors in the listing (preserved trail), so the
			// listing itself is the only place a reader learns a prior is not the answer.
			const successor = renderedProperty(entry, "supersededBy");
			if (successor !== undefined) superseded += 1;
			const status =
				successor === undefined
					? ""
					: ` — SUPERSEDED by ${successor}: this is the corrected-away text, kept for the trail, not the current answer`;
			entries.push(`- ${title ?? id} — knowledge://record/${target.contextName}/${target.track}/${id}${status}`);
			for (const field of PROVENANCE_FIELDS) {
				const value = renderedProperty(entry, field.json);
				if (value !== undefined) entries.push(`  - ${field.header}: ${value}`);
			}
			const snippet = renderedProperty(entry, "textSnippet");
			if (snippet !== undefined) entries.push(`  - ${snippet}`);
		}
		lines.push(`${results.length} of ${total} records in track "${target.track}":`, "");
		if (superseded === results.length) {
			// The route is paginated, so a fully superseded page says nothing about the track
			// unless the page is the whole track. `>=` keeps a service that reports a total
			// smaller than the page it returned on the track-level sentence rather than
			// printing a negative "not shown" count.
			const beyond =
				reportedTotal === undefined
					? "the service reported no total, so further records may exist"
					: `${total - results.length} further records are not shown`;
			lines.push(
				reportedTotal !== undefined && results.length >= reportedTotal
					? `Every entry below has been corrected by a later record: this track has no current records. Each entry is the superseded text, preserved for the trail — read its successor before relying on it.`
					: `Every entry on this page has been corrected by a later record; ${beyond} — follow the successor links before treating anything here as current.`,
				"",
			);
		} else if (superseded > 0) {
			lines.push(
				`${superseded} of the ${results.length} entries below are superseded priors, corrected by a later record and kept for the trail — not current-state answers.`,
				"",
			);
		}
		if (superseded < results.length) {
			lines.push(
				`An entry with no SUPERSEDED marker simply has no successor recorded. Supersede is two writes, so an interrupted call can leave a prior reading exactly that way; absence of a marker is not a guarantee of currency.`,
				"",
			);
		}
		lines.push(...entries);
	}

	return {
		url: url.href,
		content: `${lines.join("\n")}\n`,
		contentType: "text/markdown",
		shape: "document",
		isDirectory: true,
	};
}

/** Service text as it is safe to put on one rendered markdown line: control-stripped, tabs expanded, whitespace collapsed. */
function renderedLine(value: string): string {
	return oneLine(replaceTabs(sanitizeText(value)));
}

/** A service string property rendered for markdown, or `undefined` when absent or blank. */
function renderedProperty(object: Record<string, unknown> | null, key: string): string | undefined {
	const value = object ? stringProperty(object, key) : undefined;
	return value ? renderedLine(value) : undefined;
}

// Phase-3 dependency: local copy until `@oh-my-pi/pi-utils` exports `oneLine` (the
// central-helpers branch is adding it); both call sites then import the central helper.
function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
