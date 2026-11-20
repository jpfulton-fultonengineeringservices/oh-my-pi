import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView } from "../src/tool-render/ToolView";

describe("ToolView xd:// dispatches", () => {
	it("renders successful execute-mode xdev writes as the inner generate_image tool", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [],
					details: {
						xdev: {
							tool: "generate_image",
							mode: "execute",
							args: { subject: "alpine lake" },
							inner: {
								images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://generate_image");
		expect(html).toContain("alpine lake");
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
	});

	it("renders xd://resolve apply cards from unwrapped inner details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Applied 1 replacement in 1 file." }],
					details: {
						xdev: {
							tool: "resolve",
							mode: "execute",
							args: { reason: "looks correct" },
							inner: {
								action: "apply",
								reason: "looks correct",
								sourceToolName: "ast_edit",
								label: "ast_edit: edit foo.ts",
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://resolve");
		expect(html).toContain("proposed → resolved");
		expect(html).toContain("tv-badge--ok");
		expect(html).toContain("ast_edit: edit foo.ts");
		// The historical args-only path once left the badge as a warn "?".
		expect(html).not.toContain('tv-badge--warn">?');
	});

	it("renders xd://reject discard cards with reject semantics", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Discarded pending action." }],
					details: {
						xdev: {
							tool: "reject",
							mode: "execute",
							args: { reason: "not right" },
							inner: { action: "discard", reason: "not right", sourceToolName: "edit" },
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://reject");
		expect(html).toContain("proposed → rejected");
		expect(html).toContain("tv-badge--warn");
		// Not the generic JSON dump.
		expect(html).not.toContain("tv-out-title");
	});

	it("defaults a running xd://reject to discard before details arrive", () => {
		const html = renderToStaticMarkup(<ToolView name="reject" defaultOpen running args={{ reason: "" }} />);

		expect(html).toContain("proposed → rejected");
	});

	it("renders xd://propose plan metadata from unwrapped inner details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Plan ready for review." }],
					details: {
						xdev: {
							tool: "propose",
							mode: "execute",
							args: { title: "ship it" },
							inner: { planFilePath: "local://ship-it-plan.md", title: "ship it", planExists: true },
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://propose");
		expect(html).toContain("plan proposed");
		expect(html).toContain("local://ship-it-plan.md");
	});

	it("keeps historical top-level resolve cards working from args.action", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="resolve"
				defaultOpen
				args={{ action: "apply", reason: "ok" }}
				result={{ content: [], details: { sourceToolName: "ast_edit", label: "edit foo.ts" } }}
			/>,
		);

		expect(html).toContain("proposed → resolved");
		expect(html).toContain("tv-badge--ok");
	});

	it("renders every received wait message without falling back to JSON", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="wait"
				defaultOpen
				args={{}}
				result={{
					content: [{ type: "text", text: "[42] Worker: ready\n\n[43] Reviewer: looks good" }],
					details: {
						op: "wait",
						waited: [
							{ id: "42", from: "Worker", to: "Main", body: "ready", ts: 0 },
							{ id: "43", from: "Reviewer", to: "Main", body: "looks good", ts: 1 },
						],
					},
				}}
			/>,
		);
		expect(html).toContain("← Worker");
		expect(html).toContain("ready");
		expect(html).toContain("← Reviewer");
		expect(html).toContain("looks good");
		expect(html).not.toContain("tv-out-title");
	});

	it("renders settled wait job output", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="wait"
				defaultOpen
				args={{}}
				result={{
					content: [],
					details: {
						op: "wait",
						jobs: [
							{
								id: "a1b2",
								type: "bash",
								status: "completed",
								label: "build",
								durationMs: 25,
								resultText: "Built",
								errorText: "",
							},
						],
					},
				}}
			/>,
		);
		expect(html).toContain("Built");
		expect(html).toContain("1 done");
	});
});

describe("ToolView task renderer", () => {
	it("renders batch items by name with their task or numbered steps", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="task"
				defaultOpen
				args={{
					context: "# Goal\nship it",
					tasks: [
						{ name: "Fixer", agent: "task", task: "Patch the parser.", solutionSpace: "one fix" },
						{
							name: "Auditor",
							agent: "scout",
							steps: ["Map the callers.", "Report risky ones."],
							solutionSpace: "open",
						},
					],
				}}
			/>,
		);

		expect(html).toContain("Fixer");
		expect(html).toContain("Patch the parser.");
		expect(html).toContain("2 steps");
		expect(html).toContain("step 1/2");
		expect(html).toContain("Map the callers.");
		expect(html).toContain("step 2/2");
		expect(html).toContain("Report risky ones.");
		expect(html).toContain("2 tasks");
	});

	it("labels a flat stepped spawn by its first step when unnamed", () => {
		const html = renderToStaticMarkup(
			<ToolView name="task" args={{ agent: "task", steps: ["\n  Read the spec.\nThen more", "Write it."] }} />,
		);

		expect(html).toContain("Read the spec.");
		expect(html).not.toContain("Then more");
	});
});

describe("ToolView ask renderer", () => {
	const form = `<form>
<fieldset><legend>Storage backend</legend>
<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
<label><input type="radio" name="db" value="pg"> Postgres</label>
</fieldset>
<fieldset><legend>Notes &amp; caveats</legend><textarea name="notes"></textarea></fieldset>
</form>`;

	it("outlines a pending form by its legends and named field count", () => {
		const html = renderToStaticMarkup(<ToolView name="ask" defaultOpen args={{ html: form }} />);

		expect(html).toContain("Storage backend");
		expect(html).toContain("Notes &amp; caveats");
		expect(html).toContain("2 fields");
	});

	it("pairs each question with its answer and flags timed-out submissions", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ html: form }}
				result={{
					content: [{ type: "text", text: 'User answers:\n{"db":"pg","notes":""}' }],
					details: {
						answers: [
							{ name: "db", question: "Storage backend", answer: "Postgres" },
							{ name: "notes", question: "Notes & caveats", answer: "" },
						],
						timedOut: true,
					},
				}}
			/>,
		);

		expect(html).toContain("<span>Postgres</span>");
		expect(html).toContain("(no answer)");
		expect(html).toContain("auto-selected after timeout");
	});

	it("renders selected option notes under the matching answer", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ html: form }}
				result={{
					content: [],
					details: {
						answers: [
							{ name: "notes", question: "Notes & caveats", answer: "none" },
							{ name: "db", question: "Storage backend", answer: "SQLite, Postgres, managed" },
						],
						notes: [
							{ name: "db", question: "Storage backend", option: "Postgres, managed", text: "Team standard" },
							{ name: "db", question: "Storage backend", option: 12, text: "ignored malformed note" },
						],
					},
				}}
			/>,
		);

		expect(html).toContain("✎ Postgres, managed: Team standard");
		expect(html.indexOf("Team standard")).toBeGreaterThan(html.lastIndexOf("Storage backend"));
		expect(html).not.toContain("ignored malformed note");
	});

	it("falls back to the result text when details carry no answers", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ html: "<form></form>" }}
				result={{ content: [{ type: "text", text: "The form needs at least one named control." }], isError: true }}
			/>,
		);

		expect(html).toContain("at least one named control");
	});
});

/**
 * `retain` answers with a count line plus one id line per stored item. The dashboard
 * keeps those two jobs apart: the ok-chip is the count line alone, and each row carries
 * the handle of the content it shows. Pairing the handles by rendered position instead
 * of by the item's slot would put item 3's id on item 2 whenever a blank item is stored
 * in between — a wrong handle is worse than no handle, since `memory_edit` takes it back.
 */
describe("ToolView retain renderer", () => {
	it("keeps the per-item id lines out of the status chip and pairs ids with their rows", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="retain"
				defaultOpen
				args={{
					items: [
						{ content: "Roll the gateway before the router.", context: "deploy order" },
						{ content: "   " },
						{ content: "The health probe is the first line of the deploy log." },
					],
				}}
				result={{
					content: [
						{
							type: "text",
							text: ["3 memories stored.", "item 1 (id rec-1)", "item 2 (id rec-2)", "item 3 (id rec-3)"].join(
								"\n",
							),
						},
					],
					details: { count: 3, ids: ["rec-1", "rec-2", "rec-3"] },
				}}
			/>,
		);

		// The chip is the tool's own count sentence and nothing below it.
		expect(html).toContain(">3 memories stored<");
		expect(html).not.toContain("item 1 (id rec-1)");
		expect(html).not.toContain("3 memories stored.\nitem 1");
		// The blank middle item renders no row but keeps its slot, so item 3 is still
		// labelled with its own id rather than the one belonging to the blank item.
		expect(html).toContain("Roll the gateway before the router.");
		expect(html).toContain("id=rec-1");
		expect(html).toContain("id=rec-3");
		expect(html).not.toContain("id=rec-2");
	});

	it("puts a lone item's id on its row rather than doubling it in the chip", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="retain"
				defaultOpen
				args={{ items: [{ content: "The user prefers Bun over Node for new scripts." }] }}
				result={{
					content: [{ type: "text", text: "1 memory stored. id=rec-8f3a1c" }],
					details: { count: 1, ids: ["rec-8f3a1c"] },
				}}
			/>,
		);

		expect(html).toContain(">1 memory stored<");
		expect(html).toContain("The user prefers Bun over Node for new scripts.");
		expect(html).toContain("id=rec-8f3a1c");
	});
});
