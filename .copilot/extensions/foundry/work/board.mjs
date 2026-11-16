import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

/** @typedef {import("./model.js").Snapshot} Snapshot */
/** @param {unknown} value */
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** @param {Snapshot} snapshot */
export function renderBoard(snapshot) {
	const attempts = new Map(snapshot.attempts.map(attempt => [attempt.id, attempt]));
	const sections = snapshot.goals.map(goal => {
		const tasks = snapshot.tasks.filter(task => task.goalId === goal.id);
		const units = snapshot.units.filter(unit => unit.goalId === goal.id);
		const collaborations = snapshot.collaborations.filter(item => item.goalId === goal.id || item.destinationGoalId === goal.id);
		const completion = snapshot.completions?.find(completion => completion.goalId === goal.id);
		const factory = snapshot.factories?.find(factory => factory.id === completion?.factoryId);
		return `<section aria-labelledby="goal-${escape(goal.id)}">
<h2 id="goal-${escape(goal.id)}">${escape(goal.title)}</h2>
<p class="secondary">${tasks.filter(task => task.state === "done").length} of ${tasks.length} tasks completed &middot; ${units.length} units &middot; ${escape(goal.scope.mode)}</p>
${units.length ? `<details><summary>Organization and accountable coordinators</summary><ul>${units.slice(0, 100).map(unit => {
			const coordinator = tasks.find(task => task.id === unit.coordinatorTaskId);
			const parent = units.find(parent => parent.id === unit.parentId);
			return `<li><strong>${escape(unit.name)}</strong> &middot; ${escape(unit.kind ?? "unit")}${parent ? ` &middot; within ${escape(parent.name)}` : " &middot; organization root"}
<p class="secondary">${coordinator ? `Coordinator: ${escape(coordinator.title)} &middot; <code>${escape(coordinator.owner)}</code>` : "No coordinator assigned"}${unit.taskId ? ` &middot; task boundary <code>${escape(unit.taskId)}</code>` : ""}</p>
${unit.context.length ? `<p>${unit.context.map(escape).join("<br>")}</p>` : ""}</li>`;
		}).join("")}</ul>${units.length > 100 ? `<p>Showing 100 of ${units.length} units. Inspect the relevant task context for more detail.</p>` : ""}</details>` : ""}
${goal.source ? `<p class="secondary">Contract: <code>${escape(goal.source.reference)}</code></p>` : ""}
${completion ? `<p>Factory: ${escape(factory?.state ?? "unknown")} &middot; delivery: ${completion.delivered ? "accepted" : "incomplete"} &middot; settlement: ${completion.settled ? "settled" : "outstanding"} &middot; closure ${escape(completion.revision)}${factory?.reason ? ` &middot; ${escape(factory.reason)}` : ""}</p>` : ""}
${tasks.length ? `<div class="table-scroll"><table><caption class="visually-hidden">Work in ${escape(goal.title)}</caption><thead><tr><th scope="col">Task</th><th scope="col">State</th><th scope="col">Owner</th></tr></thead><tbody>
${tasks.map(task => {
			const attempt = task.currentAttemptId ? attempts.get(task.currentAttemptId) : undefined;
			return `<tr><td><details><summary>${escape(task.title)}${task.role === "coordinator" ? " (coordinator)" : ""}</summary>
<p>${escape(task.assignment)}</p>
${task.parentId ? `<p class="secondary">Canonical parent: ${escape(tasks.find(parent => parent.id === task.parentId)?.title ?? task.parentId)} &middot; <code>${escape(task.parentId)}</code></p>` : ""}
${attempt ? `<p class="secondary">Native execution: <code>${escape(attempt.nativeId ?? "not bound")}</code><br>Original native creator: <code>${escape(attempt.creator)}</code> &middot; slot ${attempt.slot ? "in use" : "released"}${attempt.assignedOwner ? `<br>Assigned accountable owner: <code>${escape(attempt.assignedOwner)}</code>` : ""}</p>` : ""}
${task.coordination ? `<p>Coordination work: handled ${task.coordination.handled} of ${task.coordination.generation} generations${task.coordination.generation > task.coordination.handled ? " &middot; pending work" : " &middot; awaiting new events"}</p>
${task.coordination.disposition ? `<p class="secondary">Last disposition: ${escape(task.coordination.disposition.reason)}</p>` : ""}` : ""}
${task.waiting ? `<p>Waiting: ${escape(task.waiting.reason)}${task.waiting.requestId ? ` &middot; native request <code>${escape(task.waiting.requestId)}</code>` : ""}</p>` : ""}
${task.inputs.length ? `<h3>Inputs</h3><ul>${task.inputs.map(input => `<li><code>${escape(input.taskId)}</code> &middot; ${escape(input.output)}${input.version ? ` &middot; ${escape(input.version)}` : ""}</li>`).join("")}</ul>` : ""}
${task.checks.length ? `<h3>Acceptance</h3><ul>${task.checks.map(check => `<li>${escape(check.requirement)} <span class="secondary">(${escape(check.origin)}, ${escape(check.id)})</span></li>`).join("")}</ul>` : ""}
${task.outputs.length ? `<h3>Outputs</h3><ul>${task.outputs.map(output => `<li>${escape(output.name)} &middot; ${escape(output.kind)}<br><code>${escape(output.reference)}</code><br><span class="secondary">Version ${escape(output.version)}</span></li>`).join("")}</ul>` : ""}
</details></td><td><span class="state" data-state="${escape(task.state)}">${escape(task.state)}</span>${task.waiting ? `<br><span class="secondary">${escape(task.waiting.kind)}</span>` : ""}</td><td><code title="${escape(task.owner)}">${escape(task.owner.slice(0, 8))}</code></td></tr>`;
		}).join("")}
</tbody></table></div>` : `<p>No tasks yet. Add scoped work with <code>foundry_create_task</code>.</p>`}
${collaborations.length ? `<h3>Collaboration commitments</h3><ul>${collaborations.map(item => `<li><details><summary>${escape(item.title)} &middot; ${escape(item.state)}${item.required ? " &middot; required" : " &middot; optional"}</summary>
<p>Source coordinator <code>${escape(item.sourceTaskId)}</code><br>Destination coordinator <code>${escape(item.destinationTaskId)}</code><br>Consumer <code>${escape(item.consumerTaskId)}</code></p>
<p>Output: ${escape(item.output)} &middot; revision ${item.revision}${item.producerTaskId ? `<br>Committed producer: <code>${escape(item.producerTaskId)}</code>` : ""}</p>
${item.delivery ? `<p>Delivered version: <code>${escape(item.delivery.version)}</code> &middot; ${item.bound ? "bound to source" : "source binding required"}</p>` : ""}
${item.reason ? `<p>${escape(item.reason)}</p>` : ""}</details></li>`).join("")}</ul>` : ""}
</section>`;
	}).join("");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Foundry</title>
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:var(--background-color-default,#fff);color:var(--text-color-default,#1f2328);font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);font-size:14px;line-height:1.5}
main{padding:24px;max-width:1100px;margin:auto}header{display:flex;align-items:center;justify-content:space-between;gap:16px}h1{font-size:24px;margin:0}h2{font-size:18px;margin:32px 0 8px}h3{font-size:14px;margin:20px 0 8px}p{margin:8px 0;max-width:72ch;overflow-wrap:anywhere}.secondary{color:var(--text-color-muted,#59636e)}
button{font:inherit;padding:7px 12px;border:1px solid var(--border-color-default,#d0d7de);border-radius:6px;color:inherit;background:var(--background-color-muted,#f6f8fa);cursor:pointer}button:hover{border-color:var(--color-focus-outline,#0969da)}button:focus-visible,summary:focus-visible{outline:2px solid var(--color-focus-outline,#0969da);outline-offset:3px}
table{width:100%;border-collapse:collapse;text-align:left}th{font-weight:600;color:var(--text-color-muted,#59636e)}td,th{padding:12px 8px;border-bottom:1px solid var(--border-color-default,#d0d7de);vertical-align:top}td:first-child{width:70%}summary{cursor:pointer;font-weight:500;overflow-wrap:anywhere}details[open] summary{margin-bottom:12px}code{font-family:var(--font-mono,"SFMono-Regular",Consolas,monospace);font-size:12px;overflow-wrap:anywhere}ul{padding-left:20px}.state{white-space:nowrap}.state[data-state=failed],.state[data-state=blocked]{color:var(--text-color-danger,#b42318)}.state[data-state=done]{color:var(--text-color-success,#1a7f37)}.table-scroll{overflow-x:auto}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media(prefers-color-scheme:dark){body{background:var(--background-color-default,#0d1117);color:var(--text-color-default,#e6edf3)}.secondary,th{color:var(--text-color-muted,#9198a1)}button{background:var(--background-color-muted,#151b23);border-color:var(--border-color-default,#3d444d)}td,th{border-color:var(--border-color-default,#3d444d)}.state[data-state=failed],.state[data-state=blocked]{color:var(--text-color-danger,#ff7b72)}.state[data-state=done]{color:var(--text-color-success,#56d364)}}
@media(max-width:540px){main{padding:16px}td,th{padding:12px 4px}td:first-child{width:60%}}
</style></head><body><main><header><h1>Foundry</h1><form method="get"><button type="submit">Refresh</button></form></header>
<p class="secondary">Goals, local ownership and delivered work. Expand a task for its checks and versioned inputs.</p>
${sections || "<section><h2>No active goals</h2><p>Start explicitly authorized work with <code>foundry_start_goal</code>. Installing Foundry does not change ordinary coding or native permissions.</p></section>"}
${snapshot.effects.some(effect => effect.state === "uncertain" || effect.state === "issued") ? `<section><h2>Outstanding native effects</h2><ul>${snapshot.effects.filter(effect => effect.state === "uncertain" || effect.state === "issued").map(effect => `<li>${escape(effect.kind)} &middot; ${escape(effect.state)} &middot; <code>${escape(effect.attemptId)}</code></li>`).join("")}</ul><p class="secondary">Logical outcomes do not prove that a command stopped. Reconcile the affected effect; unrelated work remains independent.</p></section>` : ""}
</main></body></html>`;
}

/** @param {{snapshot:()=>Snapshot,log:(message:string)=>void}} options */
export async function startBoard(options) {
	const token = randomBytes(24).toString("hex");
	const server = createServer((request, response) => {
		if (request.method !== "GET" || new URL(request.url ?? "/", "http://localhost").pathname !== `/${token}`) {
			response.writeHead(404).end("Not found");
			return;
		}
		try {
			const html = renderBoard(options.snapshot());
			response.writeHead(200, {
				"content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
				"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
				"x-content-type-options": "nosniff",
			}).end(html);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.log(`Foundry board: ${message}`);
			response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`Foundry could not read work records: ${message}`);
		}
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(undefined));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Foundry board did not bind a loopback port");
	return {
		url: `http://127.0.0.1:${address.port}/${token}`,
		close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve(undefined))),
	};
}
