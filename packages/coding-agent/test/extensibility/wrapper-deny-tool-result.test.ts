/**
 * A policy denial is a refusal the model has to see, but until now it was also a
 * call no extension could observe: `tool_result` was emitted only after a tool
 * ran, so an extension whose whole job is to answer a refusal — the
 * auto-fulfilling `bash` redirect being the motivating case — never saw the
 * event that would have let it. These tests pin the other half of that contract:
 * the wrapper surfaces a resolved deny as an error `tool_result`, honours a
 * handler's substituted content, and still never executes the denied tool.
 */
import { describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DEFAULT_BASH_INTERCEPTOR_RULES } from "@oh-my-pi/pi-coding-agent/exec/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ToolResultEventResult } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

/** Blocked by the default interceptor rules, and suggested to `read`. */
const BLOCKED_COMMAND = "cat package.json";
const BLOCKED_REASON = "Use the `read` tool instead of cat/head/tail";
/** Not blocked, so it clears the pre-check and only denies after revision. */
const ALLOWED_COMMAND = "echo hello";

function makeBashTool(): BashTool {
	const session = {
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": true,
			"bashInterceptor.patterns": DEFAULT_BASH_INTERCEPTOR_RULES,
		}),
		getSessionFile: () => null,
	} as unknown as ToolSession;
	return new BashTool(session);
}

interface DenyHarnessOptions {
	/** Register a `tool_result` handler at all. Defaults to true. */
	listenToResult?: boolean;
	/** What that handler returns. */
	result?: ToolResultEventResult;
	/** Rewrite the input through `tool_call`, so the later gate sees a new command. */
	rewriteTo?: string;
	/** Passive context returned alongside the `tool_call` revision. */
	callContext?: string;
	/** Passive context returned by the `tool_result` handler. */
	resultContext?: string;
}

interface DenyHarness {
	events: ToolResultEvent[];
	additionalContext: string[];
	cancelToolCallPreflight: ReturnType<typeof vi.fn>;
	emitToolResult: ReturnType<typeof vi.fn>;
	wrapper: ExtensionToolWrapper;
	executeSpy: ReturnType<typeof spyOn>;
	run: (command: string, context?: AgentToolContext) => Promise<{ content: { text?: string }[]; isError?: boolean }>;
}

function makeHarness(options: DenyHarnessOptions = {}): DenyHarness {
	const events: ToolResultEvent[] = [];
	const additionalContext: string[] = [];
	const listenToResult = options.listenToResult ?? true;
	const tool = makeBashTool();
	const executeSpy = spyOn(tool, "execute");
	const cancelToolCallPreflight = vi.fn();
	const emitToolResult = vi.fn(async (event: ToolResultEvent) => {
		events.push(event);
		const result = options.result;
		return result === undefined || options.resultContext === undefined
			? result
			: { ...result, additionalContext: options.resultContext };
	});
	const runner = {
		sessionId: "deny-tool-result-test",
		cwd: process.cwd(),
		hasUI: () => true,
		getUIContext: () => ({ select: async () => "Approve" }),
		hasSessionApproval: () => false,
		consumeToolCallEmitted: () => false,
		hasHandlers: (event: string) =>
			(event === "tool_result" && listenToResult) || (event === "tool_call" && options.rewriteTo !== undefined),
		emitToolCall: async () => {
			if (options.rewriteTo === undefined) return undefined;
			return {
				input: { command: options.rewriteTo },
				...(options.callContext === undefined ? {} : { additionalContext: options.callContext }),
			};
		},
		emitToolResult,
		cancelToolCallPreflight,
		runScoped: <T>(fn: () => T): T => fn(),
	} as unknown as ExtensionRunner;
	const wrapper = new ExtensionToolWrapper(tool as Tool, runner);
	return {
		events,
		additionalContext,
		cancelToolCallPreflight,
		emitToolResult,
		wrapper,
		executeSpy,
		run: (command, context) =>
			wrapper.execute("call-deny", { command } as never, undefined, undefined, context) as Promise<{
				content: { text?: string }[];
				isError?: boolean;
			}>,
	};
}

const yoloContext = (): AgentToolContext => {
	const addAdditionalContext = vi.fn();
	const context = {
		settings: Settings.isolated({ "tools.approvalMode": "yolo" }),
		toolNames: ["bash", "read", "grep"],
		hasUI: true,
		addAdditionalContext,
	} as unknown as AgentToolContext;
	return context;
};

const alwaysAskContext = (): AgentToolContext =>
	({
		settings: Settings.isolated({ "tools.approvalMode": "always-ask" }),
		toolNames: ["bash", "read", "grep"],
		hasUI: true,
		addAdditionalContext: vi.fn(),
	}) as unknown as AgentToolContext;

const firstText = (result: { content: { text?: string }[] }): string => result.content[0]?.text ?? "";

describe("ExtensionToolWrapper: a policy deny is observable", () => {
	it("emits an error tool_result carrying the refusal the model would have seen", async () => {
		const harness = makeHarness();

		await expect(harness.run(BLOCKED_COMMAND, alwaysAskContext())).rejects.toThrow(BLOCKED_REASON);

		expect(harness.events).toHaveLength(1);
		const [event] = harness.events;
		expect(event?.type).toBe("tool_result");
		expect(event?.toolName).toBe("bash");
		expect(event?.toolCallId).toBe("call-deny");
		expect(event?.isError).toBe(true);
		expect((event?.input as { command?: string }).command).toBe(BLOCKED_COMMAND);
		const text = (event?.content as { type: string; text?: string }[])[0]?.text ?? "";
		expect(text).toContain('Tool "bash" is blocked by tool policy.');
		expect(text).toContain(BLOCKED_REASON);
		expect(harness.executeSpy).not.toHaveBeenCalled();
	});

	it("returns handler-substituted content instead of throwing, without running the tool", async () => {
		const harness = makeHarness({
			result: {
				content: [{ type: "text", text: "## read (auto-fulfilled: read)\n1\tpackage contents" }],
				isError: false,
			},
		});

		const result = await harness.run(BLOCKED_COMMAND, alwaysAskContext());

		expect(firstText(result)).toBe("## read (auto-fulfilled: read)\n1\tpackage contents");
		expect(result.isError).toBeUndefined();
		expect(harness.executeSpy).not.toHaveBeenCalled();
		expect(harness.cancelToolCallPreflight).not.toHaveBeenCalled();
	});

	it("keeps a denial an error when the handler rewrites content without clearing the flag", async () => {
		const harness = makeHarness({ result: { content: [{ type: "text", text: "try the read tool" }] } });

		const result = await harness.run(BLOCKED_COMMAND, alwaysAskContext());

		expect(firstText(result)).toBe("try the read tool");
		expect(result.isError).toBe(true);
		expect(harness.executeSpy).not.toHaveBeenCalled();
	});

	it("changes nothing when no extension listens for tool_result", async () => {
		const harness = makeHarness({ listenToResult: false });

		await expect(harness.run(BLOCKED_COMMAND, alwaysAskContext())).rejects.toThrow(
			'Tool "bash" is blocked by tool policy.',
		);
		await expect(harness.run(BLOCKED_COMMAND, alwaysAskContext())).rejects.toThrow(BLOCKED_REASON);

		expect(harness.emitToolResult).not.toHaveBeenCalled();
		expect(harness.executeSpy).not.toHaveBeenCalled();
	});

	it("emits for a deny discovered only after the input was revised, and cancels the preflight", async () => {
		const harness = makeHarness({
			rewriteTo: BLOCKED_COMMAND,
			result: { content: [{ type: "text", text: "answered after revision" }], isError: false },
		});

		const result = await harness.run(ALLOWED_COMMAND, yoloContext());

		expect(firstText(result)).toBe("answered after revision");
		expect(harness.events).toHaveLength(1);
		expect((harness.events[0]?.input as { command?: string }).command).toBe(BLOCKED_COMMAND);
		expect(harness.cancelToolCallPreflight).toHaveBeenCalledWith("call-deny");
		expect(harness.executeSpy).not.toHaveBeenCalled();
	});

	it("withholds tool_call context from a denial but delivers the refusal handler's own", async () => {
		const context = yoloContext();
		const addAdditionalContext = (context as unknown as { addAdditionalContext: ReturnType<typeof vi.fn> })
			.addAdditionalContext;
		const harness = makeHarness({
			rewriteTo: BLOCKED_COMMAND,
			callContext: "instructions from a call that never ran",
			result: { content: [{ type: "text", text: "answered" }], isError: false },
			resultContext: "context from the refusal itself",
		});

		const result = await harness.run(ALLOWED_COMMAND, context);

		expect(firstText(result)).toBe("answered");
		expect(addAdditionalContext.mock.calls.map(call => call[0])).toEqual(["context from the refusal itself"]);
	});
});
