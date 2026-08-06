import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import {
    ACTOR_SOURCE,
    PLAN_STATUS,
    TASK_STATUS,
    actorProvenance,
} from "./domain.mjs";

const BODY_LIMIT = 32 * 1024;
const MAX_SSE_CLIENTS = 16;
const ASSETS = {
    html: readFile(new URL("./renderer/index.html", import.meta.url), "utf8"),
    script: readFile(new URL("./renderer/app.js", import.meta.url), "utf8"),
    styles: readFile(new URL("./renderer/styles.css", import.meta.url), "utf8"),
};

function json(response, status, value) {
    response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
}

function text(response, status, contentType, value) {
    response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Type": contentType,
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(value);
}

async function readJson(request) {
    const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim();
    if (contentType !== "application/json") {
        const error = new Error("Content-Type must be application/json");
        error.statusCode = 415;
        throw error;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > BODY_LIMIT) {
            const error = new Error("Request body exceeds the 32 KiB limit");
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        const error = new Error("Request body must contain valid JSON");
        error.statusCode = 400;
        throw error;
    }
}

function tokenMatches(expected, actual) {
    if (typeof actual !== "string") {
        return false;
    }
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    return expectedBuffer.length === actualBuffer.length
        && timingSafeEqual(expectedBuffer, actualBuffer);
}

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

function publicError(error) {
    return {
        code: error?.code ?? "mobius_canvas_error",
        message: error?.message ?? String(error),
        path: error?.path ?? null,
        details: error?.details ?? null,
    };
}

export async function startServer(options) {
    const {
        instanceId,
        planId,
        workspacePath,
        operations,
        subscribe,
    } = options;
    const actionToken = randomBytes(24).toString("hex");
    const clients = new Set();
    let origin = null;
    let expectedHost = null;
    let unsubscribe = () => {};

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
                const plan = await operations.getPlan({ planId });
                json(response, 200, { ok: true, value: plan });
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
                let plan;
                if (body.action === "approve") {
                    plan = await operations.approve({
                        planId,
                        expectedRevision: body.revision,
                        approvedBy: actorProvenance("canvas-user", ACTOR_SOURCE.CANVAS),
                        approvalType: body.approvalType,
                    });
                } else if (body.action === "retry") {
                    plan = await operations.retry({
                        planId,
                        taskId: body.taskId,
                        expectedRevision: body.revision,
                    });
                } else if (body.action === "cancel") {
                    plan = await operations.cancel({
                        planId,
                        taskId: body.taskId,
                        expectedRevision: body.revision,
                        target: body.target,
                        reason: body.reason,
                    });
                } else {
                    json(response, 404, { ok: false, error: { message: "Unknown canvas action" } });
                    return;
                }
                json(response, 200, { ok: true, value: plan });
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
            resolve();
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
        await new Promise((resolve) => server.close(() => resolve()));
        throw error;
    }

    return {
        instanceId,
        planId,
        server,
        url: `${origin}/`,
        broadcast,
        async snapshot() {
            return operations.getPlan({ planId });
        },
        async close() {
            unsubscribe();
            for (const client of clients) {
                client.end();
            }
            clients.clear();
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        },
    };
}

export const CANVAS_MUTABLE_PLAN_STATUSES = new Set([
    PLAN_STATUS.AWAITING_APPROVAL,
    PLAN_STATUS.APPROVED,
    PLAN_STATUS.RUNNING,
    PLAN_STATUS.VERIFYING,
    PLAN_STATUS.AWAITING_COMPLETION_APPROVAL,
    PLAN_STATUS.FAILED,
]);

export const CANVAS_RETRYABLE_TASK_STATUSES = new Set([
    TASK_STATUS.BLOCKED,
    TASK_STATUS.FAILED,
]);
