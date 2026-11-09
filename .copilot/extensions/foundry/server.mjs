import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { analysisInputDigest } from "./digest.mjs";
import { isRecord } from "./data.mjs";
import { createActionController } from "./server/actions.mjs";
import { assetFor, rendererTemplate } from "./server/assets.mjs";
import { FoundryHttpError, json, publicError, readJson, statusFor, text, tokenMatches } from "./server/http.mjs";

/** @typedef {PlanSnapshot | FactorySnapshot} BoardSnapshot */
/**
 * @typedef {object} FoundryServerOptions
 * @property {string} instanceId
 * @property {string} [planId]
 * @property {string} [repositoryPath]
 * @property {string} [unitId]
 * @property {boolean} [readOnly]
 * @property {string} workspacePath
 * @property {ReturnType<typeof import("./operations.mjs").createFoundryOperations>} operations
 * @property {() => FoundryUi | undefined} [getUi]
 * @property {typeof import("./events.mjs").subscribeToPlan} subscribe
 */
/**
 * @typedef {object} FoundryServerEntry
 * @property {string} instanceId
 * @property {string | undefined} planId
 * @property {string | undefined} repositoryPath
 * @property {string | undefined} unitId
 * @property {boolean} readOnly
 * @property {import("node:http").Server} server
 * @property {string} url
 * @property {(event?: {revision?: number, workflowRunId?: string, workflowRevision?: number}) => void} broadcast
 * @property {() => Promise<BoardSnapshot>} snapshot
 * @property {() => Promise<void>} close
 */
/** @typedef {Awaited<ReturnType<import("./operations.mjs").FoundryOperations["getStatus"]>> & {interactions: {native: boolean, readOnly: boolean}}} PlanSnapshot */
/** @typedef {{bindingId: string, plan: null, projection: null,
 * factory: ReturnType<ReturnType<typeof import("./factory.mjs").createFactoryService>["inspect"]> & {state: "available"},
 * interactions: {native: false, readOnly: true}}} FactorySnapshot */
/** @typedef {Pick<import("@github/copilot-sdk").SessionUiApi, "confirm" | "elicitation">} FoundryUi */

/** Maximum concurrent SSE subscribers for one canvas instance. */
const MAX_SSE_CLIENTS = 16;

/**
 * Starts one ephemeral loopback server bound to a stable plan.
 *
 * @param {FoundryServerOptions} options
 * @returns {Promise<FoundryServerEntry>}
 */
export async function startServer(options) {
	const {
		instanceId,
		planId,
		repositoryPath,
		unitId,
		workspacePath,
		operations,
		subscribe,
		getUi,
	} = options;
	if (Boolean(planId) === Boolean(repositoryPath)) throw new FoundryHttpError(400, "Choose exactly one planId or repositoryPath");
	if (options.readOnly !== undefined && typeof options.readOnly !== "boolean") throw new FoundryHttpError(400, "readOnly must be a boolean");
	const readOnly = options.readOnly === true || !planId;
	const bindingId = planId ?? `factory-${analysisInputDigest(repositoryPath).slice(0, 32)}`;
	const actionToken = randomBytes(24).toString("hex");
	const capabilityPath = `/c/${actionToken}/`;
	/** @type {Set<import("node:http").ServerResponse>} */
	const clients = new Set();
	/** @type {string | null} */
	let origin = null;
	/** @type {string | null} */
	let expectedHost = null;
	/** @type {() => void} */
	let unsubscribe = () => { };
	/** @returns {Promise<BoardSnapshot>} */
	const snapshot = async () => {
		if (planId) return {
			...await operations.getStatus({ planId, includeWorkflows: true }),
			interactions: { native: Boolean(getUi?.()), readOnly },
		};
		if (!repositoryPath) throw new FoundryHttpError(400, "Repository inspection requires its path");
		return {
			bindingId, plan: null, projection: null,
			factory: { state: "available", ...await operations.factoryAction({ repositoryPath, action: "inspect", input: { ...(unitId ? { unitId } : {}) } }) },
			interactions: { native: false, readOnly: true },
		};
	};

	/**
	 * Broadcasts a plan revision hint to every connected SSE client.
	 *
	 * @param {{revision?: number, workflowRunId?: string, workflowRevision?: number}} [event]
	 * @returns {void}
	 */
	const broadcast = (event = {}) => {
		const payload = `event: change\ndata: ${JSON.stringify({
			planId,
			revision: event.revision ?? null,
			workflowRunId: event.workflowRunId ?? null,
			workflowRevision: event.workflowRevision ?? null,
		})}\n\n`;
		for (const client of clients) {
			client.write(payload);
		}
	};
	const actions = createActionController({ operations, planId, getUi, broadcast });

	const server = createServer(async (request, response) => {
		response.setHeader("Referrer-Policy", "no-referrer");
		if (!expectedHost || request.headers.host !== expectedHost) {
			json(response, 421, {
				ok: false,
				error: { message: "Invalid loopback Host header" },
			});
			return;
		}
		let url;
		try {
			url = new URL(request.url ?? "/", origin ?? "http://127.0.0.1");
		} catch {
			json(response, 400, { ok: false, error: { message: "Invalid request URL" } });
			return;
		}

		try {
			const parts = url.pathname.split("/");
			if (url.origin !== origin || parts[1] !== "c" || parts.length < 4 || !tokenMatches(actionToken, parts[2])) {
				json(response, 403, { ok: false, error: { code: "foundry_capability_invalid", message: "A valid per-instance capability URL is required" } });
				return;
			}
			if (request.headers.origin && request.headers.origin !== origin) {
				json(response, 403, { ok: false, error: { message: "Invalid request origin" } });
				return;
			}
			url.pathname = `/${parts.slice(3).join("/")}`;
			if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
				const html = (await rendererTemplate)
					.replaceAll("__FOUNDRY_TOKEN__", actionToken)
					.replaceAll("__FOUNDRY_PLAN_ID__", bindingId);
				text(response, 200, "text/html; charset=utf-8", html);
				return;
			}
			const asset = request.method === "GET" ? assetFor(url.pathname) : undefined;
			if (asset) {
				text(response, 200, asset.type, await asset.content);
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/plan") {
				json(response, 200, { ok: true, value: await snapshot() });
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/workflow") {
				if (!planId) throw new FoundryHttpError(400, "Factory-only inspection has no native session execution ownership");
				const detail = await operations.getWorkflow({
					planId,
					runId: url.searchParams.get("runId") ?? "",
					...(url.searchParams.has("beforeSeq")
						? { beforeSeq: Number(url.searchParams.get("beforeSeq")) } : {}),
				});
				json(response, 200, { ok: true, value: detail });
				return;
			}
			if (request.method === "GET" && url.pathname === "/events") {
				if (clients.size >= MAX_SSE_CLIENTS) {
					json(response, 429, { ok: false, error: { message: "Too many event subscribers" } });
					return;
				}
				response.writeHead(200, {
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
					"Content-Type": "text/event-stream",
					"X-Accel-Buffering": "no",
				});
				response.write(`event: ready\ndata: ${JSON.stringify({ planId })}\n\n`);
				clients.add(response);
				request.on("close", () => clients.delete(response));
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/action") {
				if (readOnly || !planId) throw new FoundryHttpError(403, "This board is read-only");
				if (!tokenMatches(actionToken, request.headers["x-foundry-token"])) {
					json(response, 403, { ok: false, error: { message: "Invalid action token" } });
					return;
				}
				const requestOrigin = request.headers.origin;
				if (requestOrigin && requestOrigin !== origin) {
					json(response, 403, { ok: false, error: { message: "Invalid request origin" } });
					return;
				}
				const parsed = await readJson(request);
				if (!isRecord(parsed)) throw new FoundryHttpError(400, "Action input must be an object");
				await actions.handle(parsed, response);
				return;
			}
			json(response, 404, { ok: false, error: { message: "Not found" } });
		} catch (error) {
			json(response, statusFor(error), { ok: false, error: publicError(error) });
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve(undefined);
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Foundry canvas did not receive a loopback port");
	}
	origin = `http://127.0.0.1:${address.port}`;
	expectedHost = `127.0.0.1:${address.port}`;
	try {
		unsubscribe = subscribe(workspacePath, bindingId, broadcast);
	} catch (error) {
		await new Promise((resolve) => server.close(() => resolve(undefined)));
		throw error;
	}

	return {
		instanceId,
		planId,
		repositoryPath,
		unitId,
		readOnly,
		server,
		url: `${origin}${capabilityPath}`,
		broadcast,
		/**
		 * Reads the complete plan and derived projection.
		 *
	 * @returns {Promise<BoardSnapshot>}
		 */
		snapshot,
		/**
		 * Stops subscriptions, SSE streams, and the loopback server.
		 *
		 * @returns {Promise<void>}
		 */
		async close() {
			unsubscribe();
			actions.close();
			for (const client of clients) {
				client.end();
			}
			clients.clear();
			server.closeAllConnections();
			await new Promise((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve(undefined));
			});
		},
	};
}
