import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { git } from "./product.mjs";
import { digest, fail } from "./values.mjs";
import { decode } from "./snapshot.mjs";

/** @typedef {import("./model.js").Run} Run */
export const protocol = 10;

/** @param {string} cwd */
export function ledgerPath(cwd) {
	const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
	return path.join(realpathSync(common), "foundry", "work.sqlite");
}

/** @param {string} cwd @param {string} [file] @param {boolean} [create] */
export function openDatabase(cwd, file = ledgerPath(cwd), create = false) {
	const home = path.dirname(file);
	if (create) mkdirSync(home, { recursive: true, mode: 0o700 });
	else if (!lstatSync(file, { throwIfNoEntry: false })) fail("missing_run", "No Foundry ledger in this repository");
	const dir = lstatSync(home);
	if (!dir.isDirectory() || realpathSync(home) !== home)
		fail("unsafe_storage", "Expected an unlinked Foundry directory");
	if (!lstatSync(file, { throwIfNoEntry: false })) {
		for (const suffix of ["-wal", "-shm", "-journal"])
			if (lstatSync(file + suffix, { throwIfNoEntry: false }))
				fail("unsafe_storage", "Orphaned SQLite sidecar");
		try {
			closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600));
		}
		catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
				throw error;
		}
	}
	const inode = lstatSync(file);
	function verify() {
		const d = lstatSync(home), f = lstatSync(file);
		if (!d.isDirectory() || d.ino !== dir.ino || d.dev !== dir.dev || realpathSync(home) !== home || f.ino !== inode.ino || f.dev !== inode.dev)
			fail("unsafe_storage", "Ledger or directory was replaced");
		if (!f.isFile() || f.nlink !== 1) fail("unsafe_storage", "Expected an unlinked regular ledger");
		for (const suffix of ["-wal", "-shm", "-journal"]) {
			const stat = lstatSync(file + suffix, { throwIfNoEntry: false });
			// A concurrent SQLite unlink can return a regular sidecar with zero links on macOS.
			if (stat && (!stat.isFile() || stat.nlink > 1))
				fail("unsafe_storage", `Expected an unlinked regular SQLite ${suffix.slice(1)} file`);
		}
	}
	verify();
	const db = new DatabaseSync(file);
	try {
		db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE");
		const version = db.prepare("PRAGMA user_version").get()?.user_version;
		const objects = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
		if (create && version === 0 && !objects.length) {
			db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, document TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;
				CREATE INDEX runs_owner ON runs(owner); PRAGMA user_version=${protocol}`);
		}
		else if (version !== protocol || objects.length !== 2 || objects[0].type !== "table" || objects[0].name !== "runs" ||
			objects[1].type !== "index" || objects[1].name !== "runs_owner") {
			fail("unsupported_store", "Incompatible Foundry execution protocol; leave the old ledger intact");
		}
		db.exec("COMMIT");
	}
	catch (error) {
		db.close();
		throw error;
	}
	/** @param {string} id */
	function snapshot(id) {
		verify();
		const row = db.prepare("SELECT document,checksum,owner FROM runs WHERE id=?").get(id);
		if (!row)
			return;
		const parsed = decode(JSON.parse(String(row.document)));
		if (digest(parsed) !== row.checksum || parsed.id !== id || parsed.owner !== row.owner)
			fail("corrupt_run", "Run no longer matches its recorded execution snapshot");
		return { run: parsed, checksum: row.checksum };
	}
	/** @param {string} id */
	const required = id => snapshot(id) ?? fail("missing_run", `Unknown run ${id}`);
	/** @template T @param {()=>T} fn @returns {T} */
	function write(fn) {
		verify();
		db.exec("BEGIN IMMEDIATE");
		try {
			const value = fn();
			if (value && typeof value === "object" && "then" in value)
				fail("async_transaction", "Native I/O cannot run in a ledger transaction");
			verify();
			db.exec("COMMIT");
			return value;
		}
		catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
	return {
		file,
		/** @param {string} id */
		read(id) { return snapshot(id)?.run; },
		/** @param {string} actor */
		involving(actor) {
			verify();
			return db.prepare(`SELECT id FROM runs WHERE owner=? OR EXISTS (
				SELECT 1 FROM json_each(document,'$.effects') WHERE json_extract(value,'$.nativeId')=?
			) ORDER BY id`).all(actor, actor).map(r => String(r.id));
		},
		/** Plan outside the lock. A new checkpoint can also require the target tip to still match at publication.
		 * @param {string} id @param {(run:Run)=>(()=>boolean)|void} plan */
		change(id, plan) {
			for (;;) {
				const { run, checksum } = required(id);
				const valid = plan(run), next = digest(run);
				if (next === checksum || write(() => (!valid || valid()) && db.prepare("UPDATE runs SET document=?,checksum=? WHERE id=? AND checksum=?")
					.run(JSON.stringify(run), next, id, checksum).changes === 1)) return run;
			}
		},
		/** @param {Run} run */
		insert(run) { return write(() => db.prepare("INSERT INTO runs VALUES(?,?,?,?)").run(run.id, run.owner, JSON.stringify(run), digest(run))); },
		/** @template T @param {string} id @param {(run:Run)=>T} fn @returns {T} */
		update(id, fn) {
			return write(() => {
				const { run } = required(id);
				const result = fn(run);
				const doc = JSON.stringify(run);
				db.prepare("UPDATE runs SET document=?,checksum=? WHERE id=? AND document<>?").run(doc, digest(run), id, doc);
				return result;
			});
		},
		close() { db.close(); },
	};
}
