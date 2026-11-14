#!/usr/bin/env bun
/**
 * Production-binary proof for native extension discovery, mounted dispatch,
 * independent MCP failure isolation, and session switches/resume.
 *
 * Usage: bun native-extension-smoke.ts [omp-binary] [config-checkout]
 * With no arguments it proves the tree under test: this package's CLI from source,
 * against the live agent directory, which is where the extensions under proof live.
 * All model, embedding, MCP and SSH traffic is local and scripted.
 */
import type { AgentEvent, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { RpcClient, type RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { Server } from "bun";
import { getAgentDir, isRecord, ptree, readLines, removeWithRetries } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface Fixture {
	root: string;
	agentDir: string;
	project: string;
	env: Record<string, string>;
	sshAudit: string;
	mcpAudit: string;
	toolAudit: string;
}

interface RunningRpc {
	client: RpcClient;
	child: ptree.ChildProcess<"pipe">;
	stderr: () => string;
}

const binary = process.argv[2] ? path.resolve(process.argv[2]) : "";
const config = process.argv[3] ? path.resolve(process.argv[3]) : getAgentDir();
for (const [kind, file] of [
	["binary", binary],
	["config checkout", config],
] as const) {
	if (file.length === 0) continue;
	if (!path.isAbsolute(file) || !(await fs.stat(file).catch(() => undefined)))
		throw new Error(`Missing or non-absolute ${kind}: ${file}`);
}
/** With no explicit binary, the proof runs against the tree under test: the CLI from source. */
const agentCommand: string[] = binary
	? [binary]
	: [process.execPath, path.resolve(import.meta.dir, "../../src/cli.ts")];
const providerFixture = path.join(import.meta.dir, "fake-openai-server.ts");
const peerFixture = path.join(import.meta.dir, "../fixtures/rpc-mcp-server.ts");
const remoteNames = ["remote_shell", "remote_shell_read", "remote_shell_write"] as const;
const args = ["--model", "fake/fake-model", "--no-skills", "--no-rules", "--no-lsp", "--no-prewalk"];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function waitUntil(
	check: () => boolean | Promise<boolean>,
	description: string,
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function jsonl(file: string): Promise<Record<string, unknown>[]> {
	const text = (
		await Bun.file(file)
			.text()
			.catch(() => "")
	).trim();
	if (text.length === 0) return [];
	const entries = Bun.JSONL.parse(text) as unknown[];
	for (const entry of entries) assert(isRecord(entry), `Invalid JSONL entry in ${file}`);
	return entries as Record<string, unknown>[];
}

function textResult(events: AgentEvent[], toolName: string): string {
	const starts = events.filter(event => event.type === "tool_execution_start");
	assert(starts.length === 1, `Expected exactly one tool start for ${toolName}`);
	const start = starts[0]!;
	const ends = events.filter(event => event.type === "tool_execution_end");
	assert(ends.length === 1, `Expected exactly one tool end for ${toolName}`);
	const end = ends[0]!;
	assert(end.toolCallId === start.toolCallId, `Mismatched ${toolName} result`);
	const result = end.result as AgentToolResult<unknown>;
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

async function dispatch(
	run: RunningRpc,
	name: string,
	params: Record<string, unknown>,
	expectError = false,
): Promise<string> {
	const events = await run.client.promptAndWait(`write_uri xd://${name} ${JSON.stringify(params)}`);
	const text = textResult(events, "write");
	assert(text.includes("No such tool") === expectError, `Unexpected dispatch result for ${name}: ${text}`);
	const end = events.find(event => event.type === "tool_execution_end");
	assert(end?.type === "tool_execution_end" && end.isError === expectError, `Incorrect ${name} error status`);
	return text;
}

async function direct(run: RunningRpc, name: string, params: Record<string, unknown>): Promise<string> {
	return textResult(await run.client.promptAndWait(`call_tool ${name} ${JSON.stringify(params)}`), name);
}

async function readUri(run: RunningRpc, uri: string): Promise<string> {
	return textResult(await run.client.promptAndWait(`read_uri ${uri}`), "read");
}

async function fixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-extension-smoke-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp/agent");
	const project = path.join(root, "project");
	const binDir = path.join(root, "bin");
	const extensionDir = path.join(agentDir, "extensions");
	const sshAudit = path.join(root, "ssh.jsonl");
	const mcpAudit = path.join(root, "mcp.jsonl");
	const toolAudit = path.join(root, "offered-tools.jsonl");
	await fs.mkdir(project, { recursive: true });
	for (const name of ["semantic-tool-discovery.ts", "remote-shell.ts"]) {
		await fs.cp(path.join(config, "extensions", name), path.join(extensionDir, name));
	}
	await fs.cp(
		path.join(config, "extensions/lib/semantic-discovery"),
		path.join(extensionDir, "lib/semantic-discovery"),
		{ recursive: true },
	);
	await fs.symlink(path.join(config, "node_modules"), path.join(agentDir, "node_modules"), "dir");
	await Bun.write(
		path.join(agentDir, "config.yml"),
		"semanticDiscovery:\n enabled: true\n resultLimit: 10\n candidateLimit: 30\n requestTimeoutMs: 5000\n databasePath: cache/semantic-tool-discovery.lance\nmemory:\n backend: none\n",
	);
	await Bun.write(
		path.join(agentDir, "ssh.json"),
		JSON.stringify({
			hosts: { fixture: { host: "127.0.0.1", user: "fixture-user", key: path.join(root, "fixture-key") } },
		}),
	);
	await Bun.write(path.join(root, "fixture-key"), "not-a-real-credential");
	const ssh = path.join(binDir, "ssh");
	await Bun.write(
		ssh,
		`#!/usr/bin/env bun\nimport { appendFile } from "node:fs/promises";\nconst input = await Bun.stdin.text();\nawait appendFile(${JSON.stringify(sshAudit)}, JSON.stringify({ argv: process.argv.slice(2), input }) + "\\n");\nconst command = process.argv.at(-1) ?? "";\nif (command.startsWith("cat > ")) process.stdout.write("");\nelse if (command.startsWith("cat ")) process.stdout.write("fixture-read-marker");\nelse process.stdout.write("fixture-command-marker");\n`,
	);
	await fs.chmod(ssh, 0o755);
	await Bun.write(sshAudit, "");
	await Bun.write(mcpAudit, "");
	await Bun.write(toolAudit, "");
	const env = {
		PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		PI_CONFIG_DIR: ".omp",
		PI_CODING_AGENT_DIR: agentDir,
		PI_NO_TITLE: "1",
		NO_COLOR: "1",
		LITELLM_API_KEY: "fixture-key",
	};
	return { root, agentDir, project, env, sshAudit, mcpAudit, toolAudit };
}

function modelService(): { server: Server<undefined>; failedRequests(): number } {
	let failed = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/mcp" || url.pathname.endsWith("/mcp")) {
				failed++;
				return new Response("502", { status: 502 });
			}
			if (request.method === "GET")
				return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
			const body = (await request.json()) as Record<string, unknown>;
			if (url.pathname === "/v1/embeddings") {
				const texts = Array.isArray(body.input) ? body.input : [];
				return Response.json({
					data: texts.map((_, index) => ({ index, embedding: [1, ...new Array(1023).fill(0)] })),
				});
			}
			if (url.pathname === "/rerank") {
				const documents = Array.isArray(body.documents) ? body.documents : [];
				return Response.json({
					results: documents.map((_, index) => ({ index, score: documents.length - index })),
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	return { server, failedRequests: () => failed };
}

async function launch(state: Fixture, resume?: string): Promise<RunningRpc> {
	let _child: ptree.ChildProcess<"pipe"> | undefined;
	const client = new RpcClient({
		spawn: agentArgs => {
			_child = ptree.spawn([...agentCommand, ...args, ...agentArgs, ...(resume ? ["--resume", resume] : [])], {
				cwd: state.project,
				env: state.env,
				stdin: "pipe",
				detached: true,
				timeout: 120_000,
			});
			return _child! as RpcAgentProcess;
		},
	});
	const child = () => _child!;
	const stderr = () => child().peekStderr();
	await client.start();
	return { client, child: child(), stderr };
}

async function stop(run: RunningRpc): Promise<void> {
	run.child.stdin.end();
	await run.client.stop();
	await run.child.exited;
}

async function proveRpc(state: Fixture, resume?: string): Promise<string> {
	const run = await launch(state, resume);
	try {
		const initial = await run.client.getState();
		const names = initial.dumpTools?.map(tool => tool.name) ?? [];
		assert(names.includes("tool_search") && names.includes("tool_details"), `Essential tools absent: ${names}`);
		for (const name of remoteNames) assert(!names.includes(name), `Mounted ${name} leaked into direct tools`);
		// Issue a prompt to force a chat completion that captures offered schemas.
		await run.client.promptAndWait("list tools");
		await waitUntil(async () => (await jsonl(state.toolAudit)).length > 0, "provider tool schemas");
		for (const offered of await jsonl(state.toolAudit)) {
			const schemas = offered.tools;
			assert(
				Array.isArray(schemas) && JSON.stringify(schemas).includes("tool_search"),
				`Provider schemas omitted essential: ${JSON.stringify(offered)}`,
			);
		}

		const listing = await readUri(run, "xd://");
		for (const name of remoteNames) assert(listing.includes(name), `${name} missing from xd:// listing`);
		for (const name of [" shell_read", " shell_write"]) assert(!listing.includes(name), `Old name still mounted`);

		const search = await direct(run, "tool_search", { query: "remote_shell_read", limit: 10 });
		assert(
			search.includes("remote_shell_read") && search.includes("xd://remote_shell_read"),
			`Canonical search result absent: ${search}`,
		);
		const details = await direct(run, "tool_details", { name: "remote_shell_read" });
		// The declared parameters have to survive into the render. `ToolInfo.parameters` is an
		// ompType schema — a function — so a consumer that JSON-round-trips it gets `undefined`
		// back from `JSON.stringify` and stores `{}`; the converter is
		// `irToJsonSchema(schema.ir)` from `@oh-my-pi/omptype`, which does emit the properties.
		assert(
			details.includes("## remote_shell_read") &&
				details.includes("**Invocation:** xd://remote_shell_read") &&
				details.includes('"host"') &&
				details.includes('"path"'),
			`tool_details returned no parameter schema for xd://remote_shell_read: ${details}`,
		);
		for (const name of remoteNames)
			assert((await readUri(run, `xd://${name}`)).includes(name), `${name} documentation missing`);
		const sshBaseline = (await jsonl(state.sshAudit)).length;
		assert(
			(await dispatch(run, "remote_shell", { host: "fixture", command: "printf fixture" })).includes(
				"fixture-command-marker",
			),
			"Command marker missing",
		);
		assert(
			(await dispatch(run, "remote_shell_read", { host: "fixture", path: "/fixture/read" })).includes(
				"fixture-read-marker",
			),
			"Read marker missing",
		);
		const writeText = "fixture write bytes\n";
		assert(
			(
				await dispatch(run, "remote_shell_write", { host: "fixture", path: "/fixture/write", content: writeText })
			).includes("Wrote /fixture/write"),
			"Write marker missing",
		);
		assert((await jsonl(state.sshAudit)).length === sshBaseline + 3, `Expected 3 new SSH calls after baseline`);
		for (const name of ["shell_read", "shell_write"]) await dispatch(run, name, {}, true);
		assert((await jsonl(state.sshAudit)).length === sshBaseline + 3, "Old alias invoked SSH");
		const audits = await jsonl(state.sshAudit);
		assert(JSON.stringify(audits[sshBaseline]?.argv).includes("printf fixture"), "SSH argv not recorded");
		assert(
			audits[sshBaseline + 1]?.input === "" && audits[sshBaseline + 2]?.input === writeText,
			`Unexpected SSH bytes: ${JSON.stringify(audits)}`,
		);

		assert(
			(await dispatch(run, "mcp__stub_regression_announce", {})).includes("rpc-mcp-invoked"),
			"Healthy MCP did not execute",
		);
		const mcpCalls = (await jsonl(state.mcpAudit)).filter(entry => entry.method === "tools/call");
		assert(
			mcpCalls.some(entry => isRecord(entry.params) && entry.params.name === "regression_announce"),
			"MCP audit missing invocation",
		);
		const original = (await run.client.getState()).sessionFile;
		assert(original, "Temporary session was not persisted");
		assert(
			!(await run.client.openSession(path.join(state.root, "other-sessions"))).cancelled,
			"New session cancelled",
		);
		assert((await run.client.getState()).sessionFile !== original, "Session did not switch");
		assert(
			(await dispatch(run, "remote_shell_read", { host: "fixture", path: "/fixture/switch" })).includes(
				"fixture-read-marker",
			),
			"Remote tool failed after switch",
		);
		assert(!(await run.client.switchSession(original)).cancelled, "Switch back cancelled");
		assert(
			(await dispatch(run, "remote_shell_read", { host: "fixture", path: "/fixture/back" })).includes(
				"fixture-read-marker",
			),
			"Remote tool failed after switch back",
		);
		const sessionFile = original;
		run.child.stdin.end();
		await waitUntil(() => run.child.proc.exitCode !== null, "RPC process shutdown");
		assert(run.child.proc.exitCode === 0, `RPC shutdown failed: ${run.stderr()}`);
		return sessionFile;
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\nAgent stderr:\n${run.stderr()}`, {
			cause: error,
		});
	} finally {
		await stop(run).catch(() => {
			run.child.kill(undefined, 0);
		});
	}
}

const state = await fixture();
const model = ptree.spawn([process.execPath, providerFixture, state.agentDir, state.toolAudit], {
	cwd: state.project,
	env: state.env,
	stdin: "pipe",
	detached: true,
	timeout: 180_000,
});
const services = modelService();
try {
	let ready = "";
	for await (const line of readLines(model.stdout, AbortSignal.timeout(10_000))) {
		ready = new TextDecoder().decode(line);
		break;
	}
	assert(/^READY \d+/.test(ready), `Provider startup failed: ${model.peekStderr()}`);
	state.env.LITELLM_BASE_URL = `http://127.0.0.1:${services.server.port}`;
	await Bun.write(
		path.join(state.agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				stub: { command: process.execPath, args: [peerFixture, state.mcpAudit] },
				broken: { type: "http", url: `http://127.0.0.1:${services.server.port}/mcp` },
			},
		}),
	);
	const session = await proveRpc(state);
	await proveRpc(state, session);
	await waitUntil(async () => services.failedRequests() > 0, "deliberately failed MCP endpoint");
	const logsDir = path.join(state.root, "home/.omp/logs");
	const combinedLogs = await fs.readdir(logsDir).then(async names => {
		let text = "";
		for (const name of names)
			if (name.endsWith(".log")) text += await fs.readFile(path.join(logsDir, name), "utf8").catch(() => "");
		return text;
	});
	assert(
		!combinedLogs.includes("Deferred extension load failed"),
		`Deferred loader error in isolated logs: ${combinedLogs}`,
	);
	assert(
		combinedLogs.includes("broken") || combinedLogs.includes("502"),
		`Controlled MCP failure was suppressed: ${combinedLogs}`,
	);
	console.log("PASS: native extension discovery, dispatch, MCP isolation, switch/resume");
} catch (error) {
	console.error(`Smoke failed; retained fixture for inspection: ${state.root}`);
	throw error;
} finally {
	model.stdin.end();
	model.kill(undefined, 0);
	await model.exited.catch(() => {});
	services.server.stop(true);
	if (!process.exitCode) await removeWithRetries(state.root);
}
