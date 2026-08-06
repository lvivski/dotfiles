import path from "node:path";

const MOBIUS_TOOL_PREFIX = "mobius_";
const READ_ONLY_MOBIUS_TOOLS = new Set([
    "mobius_prepare_plan",
    "mobius_get_plan",
    "mobius_list_plans",
    "mobius_next_tasks",
    "mobius_prepare_verification",
]);
const FILE_WRITE_TOOLS = new Set([
    "apply_patch",
    "create",
    "edit",
    "write",
]);

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

export function classifyShellCommand(command, workingDirectory) {
    const value = String(command ?? "");
    if (splitShellCommands(value).some(isDestructiveGitCommand)) {
        return {
            decision: "deny",
            reason: "Mobius blocks destructive Git reset/clean commands while a plan is active.",
        };
    }
    if (/\b(?:rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|Remove-Item\b[^\n]*-Recurse|del\s+\/s)\b/i.test(value)) {
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

function splitShellCommands(command) {
    const segments = [];
    let current = "";
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

function isDestructiveGitCommand(command) {
    const tokens = String(command)
        .match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g)
        ?.map((token) => token.replace(/^(["'])|(["'])$/g, "")) ?? [];
    const gitIndex = tokens.findIndex((token) => token.toLowerCase() === "git");
    if (gitIndex === -1) return false;
    const prefix = tokens.slice(0, gitIndex);
    if (prefix.length > 0
        && !["sudo", "command", "env"].includes(prefix[0].toLowerCase())) {
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
    ]);
    while (index < tokens.length) {
        const token = tokens[index];
        if (token === "-C" || token === "-c"
            || token === "--git-dir" || token === "--work-tree"
            || token === "--namespace" || token === "--config-env") {
            index += 2;
            continue;
        }
        if (/^--(?:git-dir|work-tree|namespace|config-env)=/.test(token)) {
            index += 1;
            continue;
        }
        if (noArgumentOptions.has(token.toLowerCase())) {
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

function coordinatorContext(active) {
    const plan = active.plan;
    return `Mobius plan ${plan.id} is active at revision ${plan.revision} (${plan.status}).

Coordinator contract:
1. Use mobius_next_tasks and launch only dependency-ready App project sessions.
2. Do not launch overlapping declared file scopes without explicit user approval.
3. Record every returned session ID with mobius_start_task.
4. Record child results and evidence with mobius_complete_task; failed or blocked work must not be represented as done.
5. Re-read the plan after revision conflicts.
6. Conveyor agents are restricted analysis only; App-native child sessions own repository mutation.
7. Use each Mobius prepare tool's absolute pinned launchSpec with Conveyor: preview first, launch the immutable preview plan, then import or bind only the persisted run ID.
8. After mobius_prepare_verification, launch Conveyor, bind the returned run with mobius_begin_verification, import it with mobius_complete_verification, then request explicit completion approval.`;
}

export function buildMobiusHooks(options) {
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
