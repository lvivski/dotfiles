import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { git } from "./product.mjs";
import { fail } from "./values.mjs";
import { decode } from "./snapshot.mjs";
import { acceptOutcome, claimOutcome } from "./outcomes.mjs";
import { isolationSeal, keepsIsolation } from "./isolation.mjs";

/** @typedef {import("./model.js").Run} Run */
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
		db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE");
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

/** @param {string} cwd @param {string} [file] @param {boolean} [create] @param {()=>void} [checkSession] */
export function openDatabase(cwd, file = ledgerPath(cwd), create = false, checkSession) {
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
	/** @param {string} id */
	function snapshot(id) {
		verify();
		const row = db.prepare("SELECT document,checksum,owner FROM runs WHERE id=?").get(id);
		if (!row) return;
		const document = String(row.document);
		if (checksum(document) !== row.checksum) fail("corrupt_run", "Run no longer matches its recorded execution snapshot");
		const parsed = decode(JSON.parse(document));
		if (parsed.id !== id || parsed.owner !== row.owner)
			fail("corrupt_run", "Run no longer matches its recorded execution snapshot");
		const pending = parsed.effects.filter(e => e.runnerClaim && !e.receipt);
		const lookup = pending.length && journal()?.db.prepare("SELECT signature,document FROM outcomes WHERE run=? AND effect=?");
		let imported = false;
		if (lookup) for (const e of pending) {
			const row = lookup.get(id, e.id);
			if (!row) continue;
			acceptOutcome(id, e, String(row.signature), String(row.document));
			imported = true;
		}
		if (imported) decode(parsed);
		return { run: parsed, document, sum: row.checksum };
	}
	/** @param {string} id */
	const required = id => snapshot(id) ?? fail("missing_run", `Unknown run ${id}`);
	return {
		file,
		/** Inside the exclusive claim transaction. Only the holder can publish; publishing
		 * never reads or mutates the run document. @param {string} run @param {import("./model.js").Effect} effect */
		outcomeWriter(run, effect) {
			const seal = claimOutcome(run, effect);
			const store = journal(true) ?? fail("missing_store", "No runner outcome journal");
			/** @param {import("./model.js").Receipt} receipt */
			return receipt => {
				const {document, signature} = seal(receipt);
				store.write(() => {
					const inserted = store.db.prepare("INSERT INTO outcomes VALUES(?,?,?,?) ON CONFLICT(run,effect) DO NOTHING")
						.run(run, effect.id, signature, document);
					if (inserted.changes) return;
					const prior = store.db.prepare("SELECT signature,document FROM outcomes WHERE run=? AND effect=?").get(run,effect.id);
					if (prior?.signature !== signature || prior.document !== document)
						fail("conflicting_outcome", "Refusing to replace the original runner outcome");
				});
			};
		},
		/** Change notification only; consumers must still read and verify the snapshot. @param {string} id */
		stamp(id) {
			verify(); mailbox?.verify();
			const run = db.prepare("SELECT checksum FROM runs WHERE id=?").get(id);
			return `${run?.checksum ?? ""}:${mailbox?.db.prepare("SELECT max(rowid) AS stamp FROM outcomes WHERE run=?").get(id)?.stamp ?? ""}`;
		},
		/** @param {string} id */
		read(id) { return snapshot(id)?.run; },
		/** The checkout may no longer contain the activated brief. Never pick between two generations by recency.
		 * @param {string} source @param {string} owner */
		forResume(source,owner) {
			verify();
			const rows=db.prepare("SELECT id,owner FROM runs WHERE json_extract(document,'$.policy.source')=?").all(source);
			const own=rows.filter(r=>r.owner===owner);
			if (rows.length && own.length!==1) fail("run_conflict",own.length ? "Multiple owned runs use this source; specify the exact run ID" : "Only the original owner can resume this source");
			if (own.length) return required(String(own[0].id)).run;
		},
		/** Recovery needs positive evidence even for a receipt already copied into the ledger.
		 * @param {string} id @param {import("./model.js").NativeCall} e */
		verifySigned(id,e) {
			const row = journal()?.db.prepare("SELECT signature,document FROM outcomes WHERE run=? AND effect=?").get(id,e.id);
			if (!row || !e.receipt) fail("missing_receipt","Original signed runner outcome is unavailable");
			acceptOutcome(id,e,String(row.signature),String(row.document));
		},
		/** @param {string} actor */
		involving(actor) {
			verify();
			return db.prepare(`SELECT id FROM runs WHERE owner=? OR EXISTS (
				SELECT 1 FROM json_each(document,'$.effects') WHERE json_extract(value,'$.nativeId')=?
			) ORDER BY id`).all(actor, actor).map(r => String(r.id));
		},
		/** The planner may run repeatedly. Never send, prompt or launch from it.
		 * A guarded no-op still needs to confirm the same snapshot and external tip.
		 * @param {string} id @param {(run:Run)=>(()=>boolean)|void} plan */
		planAndSwap(id, plan) {
			for (;;) {
				const { run, document, sum } = required(id);
				const prior=run.independent && isolationSeal(run.independent), valid = plan(run), next = JSON.stringify(run);
				if (next!==document && !keepsIsolation(run,prior)) fail("ownership_transition","Mutation conflicts with the approved non-release checkpoint");
				if (next === document && !valid) return run;
				if (write(() => (!valid || valid()) && (next === document
					? db.prepare("SELECT checksum FROM runs WHERE id=?").get(id)?.checksum === sum
					: db.prepare("UPDATE runs SET document=?,checksum=? WHERE id=? AND checksum=?").run(next, checksum(next), id, sum).changes === 1))) return run;
			}
		},
		/** @param {Run} run */
		insert(run) {
			const doc = JSON.stringify(run);
			return write(() => db.prepare("INSERT INTO runs VALUES(?,?,?,?)").run(run.id, run.owner, doc, checksum(doc)));
		},
		/** Single synchronous transaction; keep only final identity checks and bounded mutations here.
		 * @template T @param {string} id @param {(run:Run)=>T} fn @returns {T} */
		mutateLocked(id, fn) {
			return write(() => {
				const { run, document } = required(id);
				const prior=run.independent && isolationSeal(run.independent), result = fn(run);
				const doc = JSON.stringify(run);
				if (doc!==document && !keepsIsolation(run,prior)) fail("ownership_transition","Mutation conflicts with the approved non-release checkpoint");
				if (doc !== document) db.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(doc, checksum(doc), id);
				return result;
			});
		},
		close() { mailbox?.db.close(); db.close(); },
	};
}
