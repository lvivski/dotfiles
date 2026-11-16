// Classify and summarize a batch of tickets using native workflow structured agents.
import { arrayOf, isList, isRecord, nullable, readBoolean, readString, recordOf } from "../data.mjs";
import { UNTRUSTED_DATA_WARNING, safeJson, untrustedBlock } from "../prompt.mjs";
const TICKETS_SCHEMA = {
	type: "array",
	items: {
		anyOf: [
			{ type: "string" },
			{ type: "object" },
		],
	},
};

/** @type {import("@github/copilot-sdk").WorkflowMeta} */
export const meta = {
	name: "triage",
	description:
		"Classify tickets, suggest next actions, and render a triage table. " +
		"Args: { tickets: Array<string|object>, pauseBeforeWork?: boolean } or a ticket array.",
	phases: [{ title: "Triage" }],
	argsSchema: {
		anyOf: [
			TICKETS_SCHEMA,
			{
				type: "object",
				required: ["tickets"],
				properties: {
					tickets: TICKETS_SCHEMA,
					pauseBeforeWork: { type: "boolean" },
				},
			},
		],
	},
};

/** @param {Pick<import("@github/copilot-sdk").WorkflowContext, "args" | "phase" | "agent" | "pipeline" | "step" | "log" | "pause">} workflow */
export async function run(workflow) {
	const workflowArgs = workflow.args;
	const opts =
		isRecord(workflowArgs)
			? workflowArgs
			: {};
	if (opts.pauseBeforeWork !== undefined && typeof opts.pauseBeforeWork !== "boolean") {
		throw new Error("triage: pauseBeforeWork must be a boolean");
	}
	const input = isList(workflowArgs) ? workflowArgs : opts.tickets;
	if (!isList(input) || !input.length) {
		throw new Error("triage: provide a non-empty array of tickets or { tickets: [...] }");
	}
	const normalized = input.map((ticket, index) => {
		if (typeof ticket === "string" && ticket.trim()) {
			return {
				id: String(index + 1),
				text: ticket,
			};
		}
		if (!isRecord(ticket)) {
			throw new Error(`triage: ticket ${index + 1} must be a non-empty string or object`);
		}
		const title = String(ticket.title || ticket.summary || "");
		const body = String(ticket.body || ticket.description || "");
		const text = [title, body].filter(Boolean).join("\n\n");
		if (!text.trim()) throw new Error(`triage: ticket ${index + 1} has no usable text`);
		const originalId = String(ticket.id ?? index + 1);
		const id = originalId.trim() ? originalId : String(index + 1);
		return { id, text };
	});
	const tickets = arrayOf(recordOf({ id: readString, text: readString, truncated: readBoolean }))(await workflow.step("triage:prepared-tickets:v2", () => normalized.map(({ id, text }) => ({
		id,
		text,
		truncated: false,
	}))));
	workflow.log(`triage: ${tickets.length} ticket(s)`);
	if (opts.pauseBeforeWork) {
		workflow.log(`triage: prepared tickets ${safeJson(tickets.map(({ id, text, truncated }) => ({
			id, preview: text.slice(0, 200), truncated,
		})), 0)}`);
		await workflow.pause("triage:before-triage:v1");
	}

	const TRIAGE = {
		type: "object",
		additionalProperties: false,
		properties: {
			category: { type: "string", enum: ["bug", "incident", "feature", "question", "task"] },
			priority: { type: "string", enum: ["p0", "p1", "p2", "p3"] },
			confidence: { type: "string", enum: ["high", "medium", "low"] },
			rationale: { type: "string" },
			action: { type: "string" },
		},
		required: ["category", "priority", "confidence", "rationale", "action"],
	};

	workflow.phase("Triage");
	const readTriage = nullable(recordOf({ category: readString, priority: readString, confidence: readString, rationale: readString, action: readString }));
	/** @type {Array<ReturnType<typeof readTriage>>} */
	const details = tickets.map(() => null);
	const results = await workflow.pipeline(tickets, async (_ticket, _original, index) => {
		const ticket = tickets[index];
		const detail = readTriage(await workflow.agent(
			`Triage this ticket. Choose category and priority, state calibrated confidence, explain briefly, and give one concrete next action.

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("TICKET", ticket.text)}`,
			{ label: `ticket:${index + 1}:${ticket.id}`, schema: TRIAGE },
		));
		if (
			detail === null ||
			!String(detail.rationale || "").trim() ||
			!String(detail.action || "").trim()
		) {
			return null;
		}
		details[index] = detail;
		return detail;
	});

	/** @param {unknown} value */
	const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
	const out = [
		"| ID | Status | Category | Priority | Confidence | Rationale | Next action |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	];
	let failed = 0;
	for (let index = 0; index < tickets.length; index++) {
		const ticket = tickets[index];
		const detail = results[index] === null ? null : details[index];
		if (detail === null) {
			failed++;
			out.push(`| ${cell(ticket.id)} | Failed |  |  |  | Agent failed | Retry triage |`);
			continue;
		}
		out.push(
			`| ${cell(ticket.id)} | Triaged | ${cell(detail.category)} | ${cell(
				String(detail.priority).toUpperCase(),
			)} | ${cell(detail.confidence)} | ${cell(detail.rationale)} | ${cell(detail.action)} |`,
		);
	}
	const truncated = tickets.filter((ticket) => ticket.truncated).length;
	out.push(
		"",
		`_Coverage: ${tickets.length}/${tickets.length} processed; ${tickets.length - failed} triaged, ${failed} failed, ${truncated} truncated._`,
	);
	return out.join("\n");
}
