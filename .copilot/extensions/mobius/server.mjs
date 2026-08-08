/**
 * Hardened loopback HTTP and SSE server for one Mobius canvas instance.
 *
 * @module mobius/server
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import { PLAN_STATUS, TASK_STATUS } from "./domain.mjs";

/**
 * @typedef {object} MobiusServerOptions
 * @property {string} instanceId
 * @property {string} planId
 * @property {string} workspacePath
 * @property {ReturnType<typeof import("./operations.mjs").createMobiusOperations>} operations
 * @property {(workspacePath: string, planId: string, listener: (event: any) => void) => () => void} subscribe
 */

/**
 * @typedef {object} MobiusServerEntry
 * @property {string} instanceId
 * @property {string} planId
 * @property {import("node:http").Server} server
 * @property {string} url
 * @property {(event?: {revision?: number}) => void} broadcast
 * @property {() => Promise<any>} snapshot
 * @property {() => Promise<void>} close
 */

/** Maximum accepted JSON mutation body size. */
const BODY_LIMIT = 32 * 1024;

/** Maximum concurrent SSE subscribers for one canvas instance. */
const MAX_SSE_CLIENTS = 16;

/** Lazily loaded renderer assets shared by all canvas instances. */
const ASSETS = {
    html: readFile(new URL("./renderer/index.html", import.meta.url), "utf8"),
    script: readFile(new URL("./renderer/app.js", import.meta.url), "utf8"),
    styles: readFile(new URL("./renderer/styles.css", import.meta.url), "utf8"),
};

/** HTTP-aware error for request validation failures. */
class MobiusHttpError extends Error {
    /**
     * @param {number} statusCode
     * @param {string} message
     */
    constructor(statusCode, message) {
        super(message);
        this.name = "MobiusHttpError";
        this.statusCode = statusCode;
    }
}

/**
 * Sends a non-cacheable JSON response.
 *
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {unknown} value
 * @returns {void}
 */
function json(response, status, value) {
    response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
}

/**
 * Sends a CSP-protected static text response.
 *
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {string} contentType
 * @param {string} value
 * @returns {void}
 */
function text(response, status, contentType, value) {
    response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Type": contentType,
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(value);
}

/**
 * Reads and parses a bounded JSON request body.
 *
 * @param {import("node:http").IncomingMessage} request
 * @returns {Promise<any>}
 * @throws {Error} With an HTTP-compatible `statusCode` for invalid input.
 */
async function readJson(request) {
    const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim();
    if (contentType !== "application/json") {
        throw new MobiusHttpError(415, "Content-Type must be application/json");
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > BODY_LIMIT) {
            throw new MobiusHttpError(413, "Request body exceeds the 32 KiB limit");
        }
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new MobiusHttpError(400, "Request body must contain valid JSON");
    }
}

/**
 * Compares action tokens without leaking a length-matched timing signal.
 *
 * @param {string} expected
 * @param {unknown} actual
 * @returns {boolean}
 */
function tokenMatches(expected, actual) {
    if (typeof actual !== "string") {
        return false;
    }
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    return expectedBuffer.length === actualBuffer.length
        && timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Maps Mobius failures to HTTP response status codes.
 *
 * @param {any} error
 * @returns {number}
 */
function statusFor(error) {
    if (Number.isInteger(error?.statusCode)) {
        return error.statusCode;
    }
    if (error?.code === "revision_conflict") {
        return 409;
    }
    if (error?.code === "plan_not_found") {
        return 404;
    }
    if (typeof error?.code === "string") {
        return 400;
    }
    return 500;
}

/**
 * Redacts an error to the stable canvas error envelope.
 *
 * @param {any} error
 * @returns {{code: string, message: string, path: unknown, details: unknown}}
 */
function publicError(error) {
    return {
        code: error?.code ?? "mobius_canvas_error",
        message: error?.message ?? String(error),
        path: error?.path ?? null,
        details: error?.details ?? null,
    };
}

/**
 * Starts one ephemeral loopback server bound to a stable plan.
 *
 * @param {MobiusServerOptions} options
 * @returns {Promise<MobiusServerEntry>}
 */
export async function startServer(options) {
    const {
        instanceId,
        planId,
        workspacePath,
        operations,
        subscribe,
    } = options;
    const actionToken = randomBytes(24).toString("hex");
    /** @type {Set<import("node:http").ServerResponse>} */
    const clients = new Set();
    /** @type {string | null} */
    let origin = null;
    /** @type {string | null} */
    let expectedHost = null;
    /** @type {() => void} */
    let unsubscribe = () => {};

    /**
     * Broadcasts a plan revision hint to every connected SSE client.
     *
     * @param {{revision?: number}} [event]
     * @returns {void}
     */
    const broadcast = (event = {}) => {
        const payload = `event: change\ndata: ${JSON.stringify({
            planId,
            revision: event.revision ?? null,
        })}\n\n`;
        for (const client of clients) {
            client.write(payload);
        }
    };
    const server = createServer(async (request, response) => {
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
            if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
                const template = await ASSETS.html;
                const html = template
                    .replaceAll("__MOBIUS_TOKEN__", actionToken)
                    .replaceAll("__MOBIUS_PLAN_ID__", planId);
                text(response, 200, "text/html; charset=utf-8", html);
                return;
            }
            if (request.method === "GET" && url.pathname === "/app.js") {
                text(response, 200, "text/javascript; charset=utf-8", await ASSETS.script);
                return;
            }
            if (request.method === "GET" && url.pathname === "/styles.css") {
                text(response, 200, "text/css; charset=utf-8", await ASSETS.styles);
                return;
            }
            if (request.method === "GET" && url.pathname === "/api/plan") {
                const status = await operations.getStatus({ planId });
                json(response, 200, { ok: true, value: status });
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
                if (!tokenMatches(actionToken, request.headers["x-mobius-token"])) {
                    json(response, 403, { ok: false, error: { message: "Invalid action token" } });
                    return;
                }
                const requestOrigin = request.headers.origin;
                if (requestOrigin && requestOrigin !== origin) {
                    json(response, 403, { ok: false, error: { message: "Invalid request origin" } });
                    return;
                }
                const body = await readJson(request);
                if (body?.confirmed !== true) {
                    json(response, 400, { ok: false, error: { message: "Explicit confirmation is required" } });
                    return;
                }
                if (body.action === "approve") {
                    await operations.approve({
                        planId,
                        expectedRevision: body.revision,
                        approvedBy: "canvas-user",
                        approvalType: body.approvalType,
                    });
                } else if (body.action === "retry") {
                    await operations.retry({
                        planId,
                        taskId: body.taskId,
                        expectedRevision: body.revision,
                    });
                } else if (body.action === "cancel") {
                    await operations.cancel({
                        planId,
                        taskId: body.taskId,
                        expectedRevision: body.revision,
                        requestId: body.requestId,
                        target: body.target,
                        reason: body.reason,
                        requestedBy: "canvas-user",
                    });
                } else {
                    json(response, 404, { ok: false, error: { message: "Unknown canvas action" } });
                    return;
                }
                json(response, 200, {
                    ok: true,
                    value: await operations.getStatus({ planId }),
                });
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
        throw new Error("Mobius canvas did not receive a loopback port");
    }
    origin = `http://127.0.0.1:${address.port}`;
    expectedHost = `127.0.0.1:${address.port}`;
    try {
        unsubscribe = subscribe(workspacePath, planId, broadcast);
    } catch (error) {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
        throw error;
    }

    return {
        instanceId,
        planId,
        server,
        url: `${origin}/`,
        broadcast,
        /**
         * Reads the complete plan and derived projection.
         *
         * @returns {Promise<any>}
         */
        async snapshot() {
            return operations.getStatus({ planId });
        },
        /**
         * Stops subscriptions, SSE streams, and the loopback server.
         *
         * @returns {Promise<void>}
         */
        async close() {
            unsubscribe();
            for (const client of clients) {
                client.end();
            }
            clients.clear();
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve(undefined));
            });
        },
    };
}

/** Plan states in which the board may expose mutations. */
export const CANVAS_MUTABLE_PLAN_STATUSES = new Set([
    PLAN_STATUS.AWAITING_APPROVAL,
    PLAN_STATUS.APPROVED,
    PLAN_STATUS.RUNNING,
    PLAN_STATUS.AWAITING_COMPLETION_APPROVAL,
    PLAN_STATUS.FAILED,
]);

/** Task states eligible for an explicit fresh-attempt retry. */
export const CANVAS_RETRYABLE_TASK_STATUSES = new Set([
    TASK_STATUS.BLOCKED,
    TASK_STATUS.FAILED,
]);
