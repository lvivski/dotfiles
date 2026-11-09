import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { analysisInputDigest } from "../digest.mjs";
import { errorMessage } from "../data.mjs";
import { fail } from "./fields.mjs";

/** @typedef {import("../types/factory.js").RepositoryIdentity} RepositoryIdentity */

/** @param {string} repositoryPath @returns {RepositoryIdentity} */
export function resolveRepositoryIdentity(repositoryPath) {
	if (typeof repositoryPath !== "string" || !path.isAbsolute(repositoryPath)) {
		fail("factory_repository_invalid", "repositoryPath must be an absolute Git working directory");
	}
	let commonDirectory;
	try {
		const common = execFileSync("git", ["-C", repositoryPath, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
			encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
		}).trim();
		commonDirectory = realpathSync(common);
	} catch (error) {
		fail("factory_repository_unavailable", "Cannot establish canonical Git common-directory identity", { message: errorMessage(error) });
	}
	return { id: analysisInputDigest(commonDirectory), commonDirectory };
}
