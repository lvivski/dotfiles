import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { errorCode, errorMessage, parseJson } from "../data.mjs";
import { createArtifactDatabase } from "../storage/database.mjs";
import { digest, fail, object } from "./fields.mjs";

/** @typedef {import("../types/factory.js").RepositoryIdentity} RepositoryIdentity */

/** @param {string} repositoryPath */
function locations(repositoryPath) {
	if (typeof repositoryPath !== "string" || !path.isAbsolute(repositoryPath)) {
		fail("factory_repository_invalid", "repositoryPath must be an absolute Git working directory");
	}
	try {
		const output = execFileSync("git", ["-C", repositoryPath, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], {
			encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
		}).trim().split("\n");
		if (output.length !== 2) fail("factory_repository_invalid", "Repository paths must not contain newlines");
		return { commonDirectory: realpathSync(output[0]), root: realpathSync(output[1]) };
	} catch (error) {
		fail("factory_repository_unavailable", "Cannot establish canonical Git common-directory identity", { message: errorMessage(error) });
	}
}

const FORMAT = "foundry-repository-v1";

/** @param {string} filename */
function metadata(filename) {
	try { return lstatSync(filename); }
	catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		fail("factory_knowledge_unreadable", "Cannot inspect repository knowledge", { filename, message: errorMessage(error) });
	}
}

/** @param {string} directory @param {boolean} [create] */
function directory(directory, create = false) {
	if (!metadata(directory) && create) {
		try { mkdirSync(directory, { mode: 0o700 }); }
		catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
	}
	const info = metadata(directory);
	if (!info) return false;
	if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory) {
		fail("factory_knowledge_unsafe", "Repository knowledge must use contained real directories", { directory });
	}
	return true;
}

/** @param {string} filename */
function read(filename) {
	const info = metadata(filename);
	if (!info) return null;
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
		fail("factory_knowledge_unsafe", "Repository knowledge must be regular files without links", { filename });
	}
	const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const actual = fstatSync(fd);
		if (actual.dev !== info.dev || actual.ino !== info.ino || actual.nlink !== 1) {
			fail("factory_knowledge_changed", "Repository knowledge changed while opening it", { filename });
		}
		return parseJson(readFileSync(fd, "utf8"));
	} catch (error) {
		if (errorCode(error)) throw error;
		fail("factory_knowledge_invalid", "Repository knowledge is not valid JSON", { filename, message: errorMessage(error) });
	} finally { closeSync(fd); }
}

/** @param {string} root */
function manifest(root) {
	const folder = path.join(root, ".foundry");
	if (!directory(folder)) return null;
	const value = read(path.join(folder, "repository.json"));
	if (value === null) return null;
	object(value, ["format", "id", "head"], "repository knowledge manifest");
	if (value.format !== FORMAT) fail("factory_format_unsupported", "Unknown repository knowledge format");
	return { format: FORMAT, id: digest(value.id, "repository.id"), head: digest(value.head, "repository.head") };
}

/** @param {string} repositoryPath @returns {RepositoryIdentity} */
export function resolveRepositoryIdentity(repositoryPath) {
	const { commonDirectory, root } = locations(repositoryPath);
	const stored = manifest(root);
	return { id: stored?.id ?? analysisInputDigest(commonDirectory), commonDirectory };
}

/** @param {string} filename @param {unknown} value @param {boolean} [immutable] */
function write(filename, value, immutable = false) {
	const bytes = `${stableStringify(value)}\n`;
	const previous = read(filename);
	if (immutable && previous !== null) {
		if (stableStringify(previous) !== stableStringify(value)) fail("factory_knowledge_integrity", "Immutable knowledge object has different content");
		return;
	}
	const temporary = path.join(path.dirname(filename), `.${randomUUID()}.tmp`);
	let created = false;
	try {
		const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		created = true;
		try { writeFileSync(fd, bytes); fsyncSync(fd); }
		finally { closeSync(fd); }
		if (metadata(filename)) read(filename);
		renameSync(temporary, filename);
		created = false;
		const parent = openSync(path.dirname(filename), constants.O_RDONLY | constants.O_NOFOLLOW);
		try { fsyncSync(parent); }
		finally { closeSync(parent); }
	} finally { if (created) unlinkSync(temporary); }
}

/**
 * Git owns the portable files; this private SQLite database only serializes
 * cooperating publishers across sessions and worktrees.
 * @param {{repositoryPath: string, repository: RepositoryIdentity}} options
 */
export function createKnowledgeRepository({ repositoryPath, repository }) {
	const { commonDirectory, root } = locations(repositoryPath);
	const folder = path.join(root, ".foundry");
	const objects = path.join(folder, "objects");
	const mutex = createArtifactDatabase({
		workspacePath: commonDirectory, directoryParts: ["foundry", "publication"], schemaVersion: 1,
		initialize(db) {
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			const application = db.prepare("PRAGMA application_id").get()?.application_id;
			if (version === 1 && application === 0x464b4e57) return;
			if (version !== 0 || application !== 0 || db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
				fail("factory_database_unsupported", "Knowledge publication lock has an unknown owner or schema");
			}
			db.exec("PRAGMA application_id=1179340375; PRAGMA user_version=1;");
		},
	});
	const head = () => {
		const entry = manifest(root);
		if (entry && entry.id !== repository.id) fail("factory_repository_mismatch", "The repository knowledge identity changed; reopen the correct repository");
		if (!entry) return null;
		if (!directory(objects)) fail("factory_knowledge_missing", "Repository knowledge objects are missing");
		const value = read(path.join(objects, `${entry.head}.json`));
		if (value === null || analysisInputDigest(value) !== entry.head) fail("factory_knowledge_integrity", "Repository knowledge does not match its head digest");
		return { digest: entry.head, value };
	};
	/** @param {string | null} expectedHead @param {unknown} value */
	const publish = (expectedHead, value) => {
		const current = head();
		if ((current?.digest ?? null) !== expectedHead) fail("factory_knowledge_conflict", "Repository knowledge changed outside this execution store; reconcile the branch before publishing");
		directory(folder, true);
		directory(objects, true);
		const next = analysisInputDigest(value);
		write(path.join(objects, `${next}.json`), value, true);
		if ((head()?.digest ?? null) !== expectedHead) fail("factory_knowledge_conflict", "Repository knowledge changed before publication");
		write(path.join(folder, "repository.json"), { format: FORMAT, id: repository.id, head: next });
		return next;
	};
	return {
		root, head, publish,
		/** @template T @param {() => T} operation */
		exclusive: (operation) => mutex.transaction(operation, { write: true }),
	};
}
