/**
 * Opt-in coordinator context and conservative tool-use guardrails.
 *
 * @module mobius/hooks
 */
import path from "node:path";

/** Prefix shared by every Mobius-owned tool. */
const MOBIUS_TOOL_PREFIX = "mobius_";

/** Mobius tools safe to auto-allow while a plan is active. */
const READ_ONLY_MOBIUS_TOOLS = new Set([
    "mobius_prepare_plan",
    "mobius_get_plan",
    "mobius_get_status",
    "mobius_list_plans",
    "mobius_next_tasks",
]);

/** File-oriented tools whose arguments can be checked against the workspace. */
const FILE_WRITE_TOOLS = new Set([
    "apply_patch",
    "create",
    "edit",
    "write",
]);

/**
 * Tests whether a candidate path remains inside a workspace root.
 *
 * Handles POSIX, Windows absolute, drive-relative, and UNC path families
 * without allowing cross-platform path aliases.
 *
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
function inside(root, candidate) {
    const windowsRoot = /^[A-Za-z]:[\\/]/.test(root) || /^\\\\/.test(root);
    const windowsCandidate = /^[A-Za-z]:[\\/]/.test(candidate)
        || /^\\\\/.test(candidate);
    const posixCandidate = path.posix.isAbsolute(candidate);
    if (windowsRoot ? (posixCandidate && !windowsCandidate) : windowsCandidate) {
        return false;
    }
    const implementation = windowsRoot ? path.win32 : path.posix;
    const resolvedRoot = implementation.resolve(root);
    const resolvedCandidate = implementation.isAbsolute(candidate)
        ? implementation.resolve(candidate)
        : implementation.resolve(resolvedRoot, candidate);
    const relative = implementation.relative(resolvedRoot, resolvedCandidate);
    return relative === ""
        || (!relative.startsWith("..") && !implementation.isAbsolute(relative));
}

/**
 * Extracts path-like arguments from supported file-write tools.
 *
 * @param {string} toolName
 * @param {unknown} toolArgs
 * @returns {string[]}
 */
function absolutePathsFromArgs(toolName, toolArgs) {
    const found = [];
    if (toolArgs && typeof toolArgs === "object") {
        for (const key of ["path", "file", "target", "destination", "outputPath"]) {
            const value = toolArgs[key];
            if (typeof value === "string") {
                found.push(value);
            }
        }
    }
    if (toolName === "apply_patch" && typeof toolArgs === "string") {
        for (const match of toolArgs.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File:|Move to:) (.+)$/gm)) {
            found.push(match[1].trim());
        }
    }
    return found;
}

/**
 * Classifies broad destructive shell commands while a plan is active.
 *
 * @param {unknown} command
 * @param {string | undefined} workingDirectory
 * @returns {{decision: "deny"|"ask", reason: string} | null}
 */
export function classifyShellCommand(command, workingDirectory) {
    const value = String(command ?? "");
    const commands = splitShellCommands(value);
    if (commands.some(isDestructiveGitCommand)) {
        return {
            decision: "deny",
            reason: "Mobius blocks destructive Git reset/clean commands while a plan is active.",
        };
    }
    const rmDecision = commands
        .map((entry) => classifyRmCommand(entry, workingDirectory))
        .find(Boolean);
    if (rmDecision) {
        return rmDecision;
    }
    if (/\b(?:Remove-Item\b[^\n]*-Recurse|del\s+\/s)\b/i.test(value)) {
        const broadTarget = /(?:^|[\s;])(?:\/|~|\$HOME|\.\.?|\*)?(?:[\s;&]|$)/.test(value)
            || (workingDirectory && value.includes(path.resolve(workingDirectory)));
        return {
            decision: broadTarget ? "deny" : "ask",
            reason: broadTarget
                ? "Mobius blocks broad recursive deletion while a plan is active."
                : "Mobius requires confirmation for recursive deletion while a plan is active.",
        };
    }
    return null;
}

/**
 * Splits compound shell input without splitting inside quotes.
 *
 * @param {string} command
 * @returns {string[]}
 */
function splitShellCommands(command) {
    const segments = [];
    let current = "";
    /** @type {"'"|'"'|null} */
    let quote = null;
    let escaped = false;
    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        if (escaped) {
            current += character;
            escaped = false;
            continue;
        }
        if (character === "\\") {
            current += character;
            escaped = true;
            continue;
        }
        if (quote) {
            current += character;
            if (character === quote) quote = null;
            continue;
        }
        if (character === "'" || character === "\"") {
            quote = character;
            current += character;
            continue;
        }
        const pair = command.slice(index, index + 2);
        if (character === ";" || character === "\n"
            || character === "|" || character === "&") {
            if (current.trim()) segments.push(current.trim());
            current = "";
            if (pair === "&&" || pair === "||") index += 1;
            continue;
        }
        current += character;
    }
    if (current.trim()) segments.push(current.trim());
    return segments;
}

/**
 * Tokenizes the shell subset needed by the guardrail classifiers.
 *
 * @param {string} command
 * @returns {string[]}
 */
function shellTokens(command) {
    return String(command)
        .match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g)
        ?.map((token) => token
            .replace(/^(["'])|(["'])$/g, "")
            .replace(/^[({]+|[)}]+$/g, ""))
        .filter(Boolean) ?? [];
}

/**
 * Accepts only direct commands or known non-semantic wrappers before a command.
 *
 * @param {string[]} tokens
 * @param {number} commandIndex
 * @returns {boolean}
 */
function allowedPrefix(tokens, commandIndex) {
    const prefix = tokens.slice(0, commandIndex);
    return prefix.length === 0
        || ["sudo", "command", "env"].includes(prefix[0].toLowerCase());
}

/**
 * Classifies recursive forced `rm` invocations by target breadth.
 *
 * @param {string} command
 * @param {string | undefined} workingDirectory
 * @returns {{decision: "deny"|"ask", reason: string} | null}
 */
function classifyRmCommand(command, workingDirectory) {
    const tokens = shellTokens(command);
    const rmIndex = tokens.findIndex((token) => token.toLowerCase() === "rm");
    if (rmIndex === -1 || !allowedPrefix(tokens, rmIndex)) return null;
    let recursive = false;
    let force = false;
    const targets = [];
    let optionsDone = false;
    for (const token of tokens.slice(rmIndex + 1)) {
        const lower = token.toLowerCase();
        if (!optionsDone && lower === "--") {
            optionsDone = true;
            continue;
        }
        if (!optionsDone && lower.startsWith("--")) {
            if (lower === "--recursive") recursive = true;
            else if (lower === "--force") force = true;
            continue;
        }
        if (!optionsDone && /^-[^-]+$/.test(lower)) {
            const flags = lower.slice(1);
            if (flags.includes("r") || flags.includes("R".toLowerCase())) recursive = true;
            if (flags.includes("f")) force = true;
            continue;
        }
        targets.push(token);
    }
    if (!recursive || !force) return null;
    const root = workingDirectory ? path.resolve(workingDirectory) : null;
    const broad = targets.length === 0 || targets.some((target) => {
        if (["/", "~", "$HOME", "${HOME}", ".", "..", "*"].includes(target)) {
            return true;
        }
        if (!root) return false;
        const resolved = path.resolve(root, target);
        return resolved === root || root.startsWith(`${resolved}${path.sep}`);
    });
    return {
        decision: broad ? "deny" : "ask",
        reason: broad
            ? "Mobius blocks broad recursive deletion while a plan is active."
            : "Mobius requires confirmation for recursive deletion while a plan is active.",
    };
}

/**
 * Detects destructive Git reset and clean invocations through global options.
 *
 * @param {string} command
 * @returns {boolean}
 */
function isDestructiveGitCommand(command) {
    const tokens = shellTokens(command);
    const gitIndex = tokens.findIndex((token) => token.toLowerCase() === "git");
    if (gitIndex === -1) return false;
    if (!allowedPrefix(tokens, gitIndex)) {
        return false;
    }
    let index = gitIndex + 1;
    const noArgumentOptions = new Set([
        "--bare",
        "--literal-pathspecs",
        "--no-lazy-fetch",
        "--no-optional-locks",
        "--no-pager",
        "--no-replace-objects",
        "--paginate",
        "--exec-path",
        "-p",
        "-P",
    ]);
    while (index < tokens.length) {
        const token = tokens[index];
        if (token === "-C" || token === "-c"
            || token === "--git-dir" || token === "--work-tree"
            || token === "--namespace" || token === "--config-env") {
            index += 2;
            continue;
        }
        if (/^--(?:git-dir|work-tree|namespace|config-env|exec-path)=/.test(token)) {
            index += 1;
            continue;
        }
        if (noArgumentOptions.has(token.toLowerCase())) {
            index += 1;
            continue;
        }
        if (token.toLowerCase().startsWith("--no-")) {
            index += 1;
            continue;
        }
        break;
    }
    const subcommand = tokens[index]?.toLowerCase();
    const args = tokens.slice(index + 1);
    if (subcommand === "reset") {
        return args.some((token) => token.toLowerCase() === "--hard");
    }
    if (subcommand === "clean") {
        return args.some((token) => {
            const lower = token.toLowerCase();
            return lower === "--force"
                || (/^-[^-]+$/.test(lower) && lower.slice(1).includes("f"));
        });
    }
    return false;
}

/**
 * Denies obvious file-tool writes outside the active workspace.
 *
 * @param {string} toolName
 * @param {unknown} toolArgs
 * @param {string | undefined} workingDirectory
 * @returns {{decision: "deny", reason: string} | null}
 */
export function inspectWriteBoundary(toolName, toolArgs, workingDirectory) {
    if (!workingDirectory) {
        return null;
    }
    const normalizedName = String(toolName ?? "").toLowerCase();
    if (!FILE_WRITE_TOOLS.has(normalizedName)) {
        return null;
    }
    const outside = absolutePathsFromArgs(normalizedName, toolArgs)
        .find((candidate) => !inside(workingDirectory, candidate));
    if (!outside) {
        return null;
    }
    return {
        decision: "deny",
        reason: `Mobius blocks writes outside the active workspace: ${outside}`,
    };
}

/**
 * Renders the durable coordinator workflow injected for an active plan.
 *
 * @param {any} active
 * @returns {string}
 */
function coordinatorContext(active) {
    const plan = active.plan;
    return `Mobius plan ${plan.id} is active at revision ${plan.revision} (${plan.status}).

Coordinator contract:
1. Use mobius_next_tasks, then mobius_reserve_task BEFORE create_session.
2. Pass the returned delegationPrompt unchanged and use its exact baseBranch.
3. Attach the returned App session immediately with mobius_attach_task.
4. Record the attempt result before displaying it or launching newly-unblocked work. Failed or blocked work must not be represented as done.
5. Do not duplicate active child work or expand the approved DAG. Intervene only for explicit steering, cancellation, stuck sessions, or child requests.
6. Do not launch overlapping declared scopes without an auditable scopeOverride.
7. Use mobius_get_status with a complete App session inventory before treating a recorded session as absent.
8. mobius_cancel only requests cancellation. Stop/archive every listed App session and cancel the listed Conveyor run before mobius_finalize_cancellation.
9. Re-read the plan after revision conflicts; reservation and attachment replays are idempotent only when their exact postcondition already exists.
10. Conveyor agents are restricted analysis only; App-native child sessions own repository mutation.
11. Use each prepare tool's absolute pinned launchSpec with Conveyor: preview first, launch the immutable preview plan, then import or bind only the persisted run ID.
12. mobius_prepare_verification is a mutation: call it with expectedRevision and a stable reservationId BEFORE launching Conveyor, then bind that exact reservation and run.
13. Import the bound verification result and request explicit completion approval.`;
}

/**
 * Builds inert-until-activated SDK hooks for Mobius coordination.
 *
 * @param {{operations: {getActive: () => Promise<any>}}} options
 * @returns {any} Copilot SDK hook declarations.
 */
export function buildMobiusHooks(options) {
    /**
     * Reads the current activation marker and plan.
     *
     * @returns {Promise<object | null>}
     */
    const active = async () => options.operations.getActive();

    return {
        onSessionStart: async () => {
            try {
                const current = await active();
                return current ? { additionalContext: coordinatorContext(current) } : {};
            } catch (error) {
                return {
                    additionalContext: `Mobius activation state could not be read (${error.code ?? "error"}). Do not assume a plan is active until the marker is repaired or deactivated.`,
                };
            }
        },
        onPreToolUse: async (input) => {
            let current;
            try {
                current = await active();
            } catch (error) {
                return {
                    permissionDecision: "ask",
                    permissionDecisionReason: `Mobius activation state is unreadable (${error.code ?? "error"}); confirm this tool call before proceeding.`,
                };
            }
            if (!current) {
                return {};
            }
            const toolName = String(input.toolName ?? "");
            if (READ_ONLY_MOBIUS_TOOLS.has(toolName)) {
                return { permissionDecision: "allow" };
            }
            if (toolName.startsWith(MOBIUS_TOOL_PREFIX)) {
                return {};
            }
            if (toolName === "bash" || toolName === "shell" || toolName === "powershell") {
                const command = input.toolArgs?.command ?? input.toolArgs;
                const classified = classifyShellCommand(command, input.workingDirectory);
                if (classified) {
                    return {
                        permissionDecision: classified.decision,
                        permissionDecisionReason: classified.reason,
                    };
                }
            }
            const boundary = inspectWriteBoundary(
                toolName,
                input.toolArgs,
                input.workingDirectory,
            );
            if (boundary) {
                return {
                    permissionDecision: boundary.decision,
                    permissionDecisionReason: boundary.reason,
                };
            }
            return {};
        },
        onPostToolUse: async (input) => {
            let current;
            try {
                current = await active();
            } catch {
                return {
                    additionalContext: "Mobius activation state is unreadable. Repair or deactivate it before coordinating more plan work.",
                };
            }
            const toolName = String(input.toolName ?? "");
            if (toolName === "mobius_deactivate_plan") {
                return {
                    additionalContext: "Mobius coordinator context and guardrails are now deactivated for this session.",
                };
            }
            if (!current || !toolName.startsWith(MOBIUS_TOOL_PREFIX)) {
                return {};
            }
            if (toolName === "mobius_activate_plan") {
                return { additionalContext: coordinatorContext(current) };
            }
            return {
                additionalContext: "A Mobius tool completed. Use the revision in its result for the next mutation.",
            };
        },
        onPostToolUseFailure: async (input) => {
            let current;
            try {
                current = await active();
            } catch {
                return {
                    additionalContext: "Mobius activation state is unreadable. Do not retry plan mutations until it is repaired.",
                };
            }
            if (!current || !String(input.toolName ?? "").startsWith(MOBIUS_TOOL_PREFIX)) {
                return {};
            }
            return {
                additionalContext: "The Mobius operation failed. Re-read the current plan revision before retrying; do not blindly replay a stale mutation.",
            };
        },
    };
}
