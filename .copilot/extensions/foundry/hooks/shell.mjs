import path from "node:path";

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
			reason: "Foundry blocks destructive Git reset/clean commands while a plan is active.",
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
				? "Foundry blocks broad recursive deletion while a plan is active."
				: "Foundry requires confirmation for recursive deletion while a plan is active.",
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
 * Detects shell constructs whose target cannot be resolved statically.
 *
 * @param {string} value
 * @returns {boolean}
 */
function containsCommandSubstitution(value) {
	return value.includes("$(") || value.includes("`");
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
		if (containsCommandSubstitution(target)) {
			return true;
		}
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
			? "Foundry blocks broad recursive deletion while a plan is active."
			: "Foundry requires confirmation for recursive deletion while a plan is active.",
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
