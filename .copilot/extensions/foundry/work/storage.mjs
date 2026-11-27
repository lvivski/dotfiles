import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { git } from "../../../skills/foundry/scripts/git-files.mjs";
import { fail } from "./values.mjs";

export const protocol = 13;
/** @param {string} document */
export const checksum = document => createHash("sha256").update(document).digest("hex");

/** @param {string} cwd */
export function ledgerPath(cwd) {
	const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
	return path.join(realpathSync(common), "foundry", "work.sqlite");
}

/** @param {string} file @param {boolean} create @param {(db:DatabaseSync,version:unknown,objects:Record<string,unknown>[])=>void} schema @param {()=>void} [checkSession] */
function openStore(file, create, schema, checkSession) {
	checkSession?.();
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
		checkSession?.();
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
		db.exec(`PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; BEGIN${create?" IMMEDIATE":""}`);
		const version = db.prepare("PRAGMA user_version").get()?.user_version;
		const objects = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
		schema(db, version, objects);
		db.exec("COMMIT");
	}
	catch (error) {
		db.close();
		throw error;
	}
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
	return { db, verify, write };
}

/** @param {string} file @param {boolean} [create] @param {()=>void} [checkSession] */
export function openLedger(file,create=false,checkSession){
	const { db, verify, write } = openStore(file, create, (db, version, objects) => {
		if (create && version === 0 && !objects.length) {
			db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, document TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;
				CREATE INDEX runs_owner ON runs(owner); PRAGMA user_version=${protocol}`);
		} else if (version !== protocol || objects.length !== 2 || objects[0].type !== "table" || objects[0].name !== "runs" ||
			objects[1].type !== "index" || objects[1].name !== "runs_owner")
			fail("unsupported_store", "Incompatible Foundry execution protocol; leave the old ledger intact");
	}, checkSession);
	const spool = `${file}.outcomes`;
	/** @type {ReturnType<typeof openStore>|undefined} */ let mailbox;
	function journal(create = false) {
		if (!mailbox && (create || lstatSync(spool, { throwIfNoEntry: false }))) {
			mailbox = openStore(spool, create, (db, version, objects) => {
				if (create && version === 0 && !objects.length)
					db.exec(`CREATE TABLE outcomes(run TEXT NOT NULL, effect TEXT NOT NULL, signature TEXT NOT NULL,
						document TEXT NOT NULL, PRIMARY KEY(run,effect)) STRICT; PRAGMA user_version=1`);
				else if (version !== 1 || objects.length !== 1 || objects[0].type !== "table" || objects[0].name !== "outcomes")
					fail("unsupported_store", "Incompatible Foundry runner outcome journal");
			}, verify);
		}
		mailbox?.verify();
		return mailbox;
	}
	/** @param {string} run @param {string} id @param {ReturnType<typeof import("./outcomes.mjs").claimOutcome>} seal @param {{committed:boolean}} claim */
	function publisher(run,id,seal,claim){
		const store = journal(true) ?? fail("missing_store", "No runner outcome journal");
		/** @param {import("./model.js").Receipt} receipt */
		const publish=receipt => {
			if(!claim.committed)fail("unissued_check","Runner claim did not commit");
			const {document, signature} = seal(receipt);
			store.write(() => {
				const inserted = store.db.prepare("INSERT INTO outcomes VALUES(?,?,?,?) ON CONFLICT(run,effect) DO NOTHING")
					.run(run, id, signature, document);
				if (inserted.changes) return;
				const prior = store.db.prepare("SELECT signature,document FROM outcomes WHERE run=? AND effect=?").get(run,id);
				if (prior?.signature !== signature || prior.document !== document)
					fail("conflicting_outcome", "Refusing to replace the original runner outcome");
			});
		};
		return Object.assign(publish,{signPreparation:(/** @type {string} */ inputs,/** @type {string} */ tree)=>{
			if(!claim.committed)fail("unissued_check","Runner claim did not commit");return seal.signPreparation(inputs,tree);
		}});
	}
	return {db,write,verify,journal,publisher,close(){mailbox?.db.close();db.close();}};
}
