/**
 * Bearer decision parity across every fork site that reads a `.memvidkb` bearer.
 *
 * The config repo's `__tests__/knowledge-config-parity.test.ts` imports only its own reader
 * (line 21: `from "../extensions/lib/knowledge/config"`), so drift on this side of the
 * boundary is structurally invisible to it — that is exactly how a loader-level trim in this
 * repo once walked through a green gate. This file is the guard that harness can never be: it
 * imports BOTH of the fork's loaders and BOTH of its send sites in one file and pins, per env
 * value, that all four land on the same side of ONE accept/reject line.
 *
 * The line is the deployed reader's, transcribed from
 * `agents/fulton-omp-config/__tests__/knowledge-config-parity.test.ts:107-123`, which asserts
 * `loadMemvidkb(workspace, () => "   ")` yields no error and only the later resolve refuses:
 *
 *   undefined | ""   refused at load, code TOKEN_ENV_UNSET
 *   "   "            ACCEPTED at load, refused only at the send boundary, never on the wire
 *   "  tok  "        accepted at load, sent as `Bearer tok`
 *
 * Moving a refusal up into any gate reddens the `"   "` row; moving one down into a send site
 * reddens the `undefined` / `""` rows. The transport is stubbed in-process with `Bun.serve` —
 * the house idiom, copied from `test/memvidkb-client.test.ts:115-142`, itself taken from
 * `test/hindsight-outbox.test.ts:35-64` — so "no request was made" is a measured fact about
 * the socket rather than an assertion about a mock, and the port is ephemeral.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import {
	DEFAULT_RECALL_MAX_BYTES,
	loadMemvidkb,
	loadMemvidkbConfig,
	type KnowledgeConfig,
} from "@oh-my-pi/pi-coding-agent/internal-urls/knowledge-config";
import { KnowledgeProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/knowledge-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { findTrack } from "../../src/memvidkb/client";
import { loadMemvidkbBackendConfig } from "../../src/memvidkb/config";
import { KNOWLEDGE_ERROR_PREFIX } from "../../src/memvidkb/errors";

const TOKEN_ENV = "MEMVIDKB_BEARER_PARITY_TOKEN";
const TOKEN = "kb-bearer-parity-4e21";
const PADDED = `  ${TOKEN}  `;

type Recorded = { path: string; authorization: string | null };

let server: Bun.Server<undefined>;
let baseUrl = "";
let requests: Recorded[] = [];

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const tmp = TempDir.createSync("@knowledge-bearer-parity-");
	try {
		return await fn(tmp.path());
	} finally {
		await tmp.remove();
	}
}

function setToken(value: string | undefined): void {
	if (value === undefined) delete process.env[TOKEN_ENV];
	else process.env[TOKEN_ENV] = value;
}

/** A consented config whose bearer lives in `TOKEN_ENV`, pointed at the stub origin. */
function writeConfig(dir: string): Promise<number> {
	const doc: KnowledgeConfig = {
		version: 1,
		context: "work",
		baseUrl,
		tokenEnvVar: TOKEN_ENV,
		providers: ["litellm"],
		tracks: ["notes"],
		remember: "off",
		injectRecall: false,
		recallMaxBytes: DEFAULT_RECALL_MAX_BYTES,
		startupRecall: [],
	};
	return Bun.write(path.join(dir, ".memvidkb"), JSON.stringify(doc));
}

/** The shapes the client deserializes, so an accepted bearer lands on a parseable page. */
function respondTo(pathname: string, method: string): Response {
	if (pathname === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain" } });
	if (pathname.endsWith("/find")) {
		return Response.json({
			query: "bearer",
			limit: 10,
			offset: 0,
			total: 1,
			mode: "lexical",
			results: [
				{
					frameId: "frame-1",
					documentId: "mv2://notes/bearer.md",
					uri: "mv2://notes/bearer.md#chunk-0",
					score: 0.9,
					textSnippet: "A whitespace bearer never reaches the wire.",
					title: "Bearer parity",
					timestamp: 1_763_000_000,
				},
			],
		});
	}
	if (method === "POST") {
		return Response.json({
			id: "doc-1",
			uri: "mv2://notes/records/doc-1",
			frameId: "frame-1",
			track: "notes",
			title: "Bearer parity",
			tags: [],
			originActor: "alice",
			capturedAt: "2026-11-01T09:00:00Z",
			derivedFrom: null,
		});
	}
	return Response.json({
		track: "notes",
		total: 1,
		limit: 5,
		offset: 0,
		results: [
			{
				id: "doc-1",
				uri: "mv2://notes/records/doc-1",
				title: "Bearer parity",
				tags: [],
				originActor: "alice",
				capturedAt: "2026-11-01T09:00:00Z",
				lastVerifiedAt: "2026-11-09T12:00:00Z",
				derivedFrom: null,
				supersededBy: null,
				textSnippet: "A whitespace bearer never reaches the wire.",
			},
		],
	});
}

beforeEach(async () => {
	requests = [];
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({ path: url.pathname, authorization: request.headers.get("authorization") });
			return respondTo(url.pathname, request.method);
		},
	});
	baseUrl = `http://127.0.0.1:${(server as unknown as { port: number }).port}`;
});

afterEach(() => {
	setToken(undefined);
	server.stop(true);
});

/**
 * Read the bearer through every fork gate that decides whether a request may happen.
 * The result types stay inferred on purpose: `"ok" in ...` and `backend.error` are the
 * assertions, and they only typecheck against the loaders' real unions.
 */
async function decisions(dir: string): Promise<{
	loader: ReturnType<typeof loadMemvidkb>;
	asyncLoader: Awaited<ReturnType<typeof loadMemvidkbConfig>>;
	backendLoader: Awaited<ReturnType<typeof loadMemvidkbBackendConfig>>;
}> {
	return {
		loader: loadMemvidkb(dir),
		asyncLoader: await loadMemvidkbConfig(dir),
		backendLoader: await loadMemvidkbBackendConfig(dir),
	};
}

describe("bearer accept/reject parity across the fork's readers and send sites", () => {
	it("refuses an unset or empty bearer at load, in every reader", async () => {
		await withTempDir(async dir => {
			await writeConfig(dir);
			for (const value of [undefined, ""]) {
				setToken(value);
				const seen = await decisions(dir);
				expect(seen.loader, "loadMemvidkb").toMatchObject({ err: { code: "TOKEN_ENV_UNSET" } });
				expect(seen.asyncLoader, "loadMemvidkbConfig").toMatchObject({ err: { code: "TOKEN_ENV_UNSET" } });
				const backend = seen.backendLoader;
				if ("config" in backend) throw new Error("backend loader must refuse a blank bearer");
				expect(backend.error.startsWith(KNOWLEDGE_ERROR_PREFIX.invalidConfig)).toBe(true);
				expect(backend.error).toContain(TOKEN_ENV);
				expect(backend.error).toContain("TOKEN_ENV_UNSET");
			}
		});
	});

	it("accepts a whitespace-only bearer at load everywhere, and refuses it at both send sites", async () => {
		await withTempDir(async dir => {
			await writeConfig(dir);
			// Load: accepted by all three readers, because the deployed reader accepts it too
			// (`knowledge-config-parity.test.ts:120-121`). A gate here would be schema drift.
			setToken("   ");
			const seen = await decisions(dir);
			expect("ok" in seen.loader, "loadMemvidkb must accept").toBe(true);
			expect("ok" in seen.asyncLoader, "loadMemvidkbConfig must accept").toBe(true);
			const backend = seen.backendLoader;
			if (!("config" in backend)) throw new Error(`backend loader must accept, got: ${backend.error}`);
			expect(backend.config.token).toBe("   ");

			// Send, protocol side: refused before the socket.
			const protocol = await new KnowledgeProtocolHandler().resolve(
				parseInternalUrl("knowledge://track/work/notes"),
				{
					cwd: dir,
				},
			);
			expect(requests, "no knowledge:// request may be made").toHaveLength(0);
			expect(protocol.notes).toEqual(["TOKEN_ENV_UNSET"]);
			expect(protocol.content).toContain(TOKEN_ENV);

			// Send, backend client side: same refusal, same prefix, still no socket.
			requests = [];
			const outcome = await findTrack(
				{ baseUrl, tokenEnvVar: TOKEN_ENV, token: backend.config.token },
				"notes",
				"bearer",
			);
			expect(outcome.ok).toBe(false);
			if (outcome.ok) return;
			expect(outcome.error.startsWith(KNOWLEDGE_ERROR_PREFIX.invalidConfig)).toBe(true);
			expect(outcome.error).toContain(TOKEN_ENV);
			expect(outcome.error).toContain("TOKEN_ENV_UNSET");
			expect(requests, "no client request may be made").toHaveLength(0);
		});
	});

	it("sends the trimmed bearer from both send sites, never the padded env value", async () => {
		await withTempDir(async dir => {
			await writeConfig(dir);
			setToken(PADDED);
			// Load hands the padding down untouched — the send sites own normalisation.
			const seen = await decisions(dir);
			expect("ok" in seen.loader).toBe(true);
			if (!("config" in seen.backendLoader)) throw new Error("backend loader must accept a padded bearer");
			expect(seen.backendLoader.config.token).toBe(PADDED);

			await new KnowledgeProtocolHandler().resolve(parseInternalUrl("knowledge://record/work/notes/doc-1"), {
				cwd: dir,
			});
			const protocolCall = requests.find(call => call.authorization !== null);
			expect(protocolCall?.authorization, "protocol send").toBe(`Bearer ${TOKEN}`);

			requests = [];
			const outcome = await findTrack(
				{ baseUrl, tokenEnvVar: TOKEN_ENV, token: seen.backendLoader.config.token },
				"notes",
				"bearer",
			);
			expect(outcome.ok).toBe(true);
			expect(requests[0]?.authorization, "client send").toBe(`Bearer ${TOKEN}`);
			for (const call of requests) expect(call.authorization).not.toContain("  ");
		});
	});

	it("keeps the bearer out of every refusal message while naming its variable", async () => {
		await withTempDir(async dir => {
			await writeConfig(dir);
			setToken("");
			const refused = loadMemvidkb(dir);
			if (!("err" in refused)) throw new Error("expected an unset-token config error");
			expect(refused.err.msg).toContain(TOKEN_ENV);
			expect(refused.err.msg).not.toContain(TOKEN);

			const blank = await findTrack({ baseUrl, tokenEnvVar: TOKEN_ENV, token: "  \t " }, "notes", "q");
			expect(blank.ok).toBe(false);
			if (blank.ok) return;
			expect(blank.error).toContain(TOKEN_ENV);
			expect(blank.error).not.toContain(TOKEN);

			// A padded value is accepted, sent trimmed, and the document on disk holds only the name.
			setToken(PADDED);
			const sent = await findTrack({ baseUrl, tokenEnvVar: TOKEN_ENV, token: PADDED }, "notes", "q");
			expect(sent.ok).toBe(true);
			expect(requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
			const onDisk = await fs.readFile(path.join(dir, ".memvidkb"), "utf8");
			expect(onDisk).not.toContain(TOKEN);
		});
	});
});
