/**
 * `log(message)` is documented as a progress line, so its text has to reach the
 * model-visible cell output — not only the TUI card's status tree. Both runtimes
 * print it through the same sink `print` uses and keep emitting the `log` status
 * event, which is what the card renders.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { disposePyToolBridge } from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { type EvalCellResult, type EvalToolDetails, evalToolRenderer } from "@oh-my-pi/pi-tui/tools/eval";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { $which, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let temp: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	temp = TempDir.createSync("@eval-log-output-");
	setAgentDir(path.join(temp.path(), "agent"));
});

afterEach(async () => {
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	restoreSettingsTestState(settingsState);
	// The tools opened `<agentDir>/agent.db`; Windows cannot delete an open database.
	AgentStorage.close();
	temp.removeSync();
});

function makeSession(): ToolSession {
	const id = `log-output-${crypto.randomUUID()}`;
	return {
		cwd: temp.path(),
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"eval.autoProvision": false,
			"python.interpreter": Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => id,
		getEvalSessionId: () => id,
		getToolByName: () => undefined,
	};
}

// Real Python kernels only under PI_PYTHON_INTEGRATION=1, like the other real-kernel suites.
const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";

const LOG_ONLY = 'log("only this")';
const CELLS = { js: `${LOG_ONLY}; print("printed")`, py: `${LOG_ONLY}\nprint("printed")` };

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function logEvents(cell: EvalCellResult | undefined) {
	return (cell?.statusEvents ?? []).filter(event => event.op === "log");
}

interface NativeLike {
	k?: string;
	c?: readonly unknown[];
	p?: Record<string, unknown>;
}

function nodes(children: readonly unknown[] | undefined): NativeLike[] {
	return (children ?? []).filter((child): child is NativeLike => typeof child === "object" && child !== null);
}

/** The eval card's `omp.run.status` section, one entry per status line. */
function statusLines(details: EvalToolDetails | undefined): string[] {
	const view = evalToolRenderer.describeResult(
		{ content: [{ type: "text", text: "" }], details },
		{ expanded: false, isPartial: false },
	);
	const box = nodes(view.body)[0];
	const status = nodes(box?.c).find(child => child.p?.role === "omp.run.status");
	return nodes(status?.c).map(line =>
		((line.p?.spans as { t: string }[] | undefined) ?? []).map(span => span.t).join(""),
	);
}

function collectStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
	else if (value && typeof value === "object") for (const nested of Object.values(value)) collectStrings(nested, out);
	return out;
}

function findRole(node: NativeLike | undefined, role: string, out: NativeLike[] = []): NativeLike[] {
	if (!node) return out;
	if (node.p?.role === role) out.push(node);
	for (const child of nodes(node.c)) findRole(child, role, out);
	return out;
}

/** The expanded eval card, as rendered text, optionally scoped to one section role. */
function cardText(details: EvalToolDetails | undefined, role?: string): string {
	const view = evalToolRenderer.describeResult(
		{ content: [{ type: "text", text: "" }], details },
		{ expanded: true, isPartial: false },
	);
	const sections = role ? findRole(nodes(view.body)[0], role) : nodes(view.body);
	return sections.map(section => collectStrings(section).join("\n")).join("\n");
}

describe("eval log() output", () => {
	beforeAll(async () => {
		await initTheme();
	});

	for (const language of ["js", "py"] as const) {
		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: prints the line into the cell output the model reads, in call order`,
			async () => {
				const result = await new EvalTool(makeSession()).execute("call", {
					language,
					code: CELLS[language],
					timeout: 0,
				});
				expect(result.isError).not.toBe(true);
				expect(resultText(result).trim().split("\n")).toEqual(["only this", "printed"]);
			},
		);

		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: a cell whose only statement is log() is no longer reported as (no output)`,
			async () => {
				const result = await new EvalTool(makeSession()).execute("call", { language, code: LOG_ONLY, timeout: 0 });
				expect(result.isError).not.toBe(true);
				expect(resultText(result).trim()).toBe("only this");
			},
		);

		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: still emits the log status event, which is what the TUI card renders`,
			async () => {
				const result = await new EvalTool(makeSession()).execute("call", {
					language,
					code: CELLS[language],
					timeout: 0,
				});
				expect(logEvents(result.details?.cells?.[0])).toEqual([
					expect.objectContaining({ op: "log", message: "only this" }),
				]);
				// The card renders that same event as its own status line, unchanged by the print.
				expect(statusLines(result.details)).toContain("log message=only this");
			},
		);

		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: the logged line also lands in the card's cell output block`,
			async () => {
				const result = await new EvalTool(makeSession()).execute("call", {
					language,
					code: CELLS[language],
					timeout: 0,
				});
				const output = cardText(result.details, "omp.tool.eval.output");
				// Once in the output block, once in the status row below it: the print is new,
				// the status row is the pre-existing affordance the brief asks to keep.
				expect(output.split("only this").length - 1).toBe(1);
				expect(output).toContain("printed");
				expect(statusLines(result.details).filter(line => line === "log message=only this")).toHaveLength(1);
			},
		);
	}

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: a log() before an exception still reaches the model (the frame is flushed, not buffered)",
		async () => {
			const result = await new EvalTool(makeSession()).execute("call", {
				language: "py",
				code: 'log("logged before failure")\nraise RuntimeError("boom")',
				timeout: 0,
			});
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("logged before failure");
		},
	);
});
