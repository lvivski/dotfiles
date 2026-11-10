/**
 * Physical storage for the unchanged v2 logical ledger. SQLite owns locking and
 * transactions; immutable archive pages and append-only rows own retention.
 */
import os from "node:os";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { errorCode, errorMessage, isList, isOneOf, isRecord, parseJson } from "../data.mjs";
import { createArtifactDatabase } from "../storage/database.mjs";
import { FACTORY_ACTIONS, prepareCommand } from "./replay.mjs";

/** @typedef {import("../types/factory.js").FactoryAction} FactoryAction */
/** @typedef {import("../types/factory.js").FactoryEvent} FactoryEvent */
/** @typedef {import("../types/factory.js").FactoryDocument} FactoryDocument */
/** @typedef {import("node:sqlite").DatabaseSync} Database */
export { FACTORY_ACTIONS };

const APPLICATION_ID = 0x46414354;
const STORAGE_VERSION = 4;
export const FACTORY_STORAGE_LIMITS = Object.freeze({
	eventBytes: 128 * 1024, segmentEvents: 8192, segmentBytes: 32 * 1024 * 1024,
	transferEvents: 256, transferBytes: 4 * 1024 * 1024, jsonBytes: 32 * 1024 * 1024,
});
const bounds = FACTORY_STORAGE_LIMITS;

/**
 * @param {{repository: {id: string, commonDirectory: string}, format: string, storageRoot?: string,
 * busyTimeoutMs?: number, now: () => string,
 * replay: (document: FactoryDocument, identity: import("../types/factory.js").RepositoryIdentity) => import("../types/factory.js").FactoryState,
 * applyEvent: import("../types/factory.js").ApplyFactoryEvent,
 * fail: (code: string, message: string, details?: unknown) => never}} options
 */
export function createFactoryLedger({ repository, format, storageRoot, busyTimeoutMs, now, replay, applyEvent, fail: reportFailure }) {
	/** @param {string} code @param {string} message @param {unknown} [details] @returns {never} */
	function fail(code, message, details) { return reportFailure(code, message, details); }
	/** @returns {FactoryDocument} */
	const empty = () => ({ format, repository, revision: 0, events: [] });
	/** @param {FactoryEvent[]} entries */
	const historyDigest = (entries, portable = false) => {
		let digest = analysisInputDigest({ ...empty(), ...(portable ? { portable: true } : {}) });
		for (const event of entries) digest = analysisInputDigest([digest, analysisInputDigest(event)]);
		return digest;
	};
	/** @param {unknown} value @param {string} label */
	const checkRevision = (value, label) => {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("factory_revision_invalid", `${label} must be a nonnegative safe integer`);
		return value;
	};
	/** Only the envelope is trusted here; replay checks every action-specific field. @param {unknown} event @returns {asserts event is FactoryEvent} */
	function eventEnvelope(event) {
		if (!isRecord(event) || typeof event.revision !== "number" || typeof event.at !== "string"
			|| !isOneOf(event.action, FACTORY_ACTIONS) || !isRecord(event.input)) fail("factory_input_invalid", "Factory event has an invalid envelope");
	}
	/** @param {unknown} value @returns {asserts value is FactoryDocument} */
	function assertDocumentEnvelope(value) {
		if (!isRecord(value) || typeof value.format !== "string" || typeof value.revision !== "number"
			|| !isRecord(value.repository) || typeof value.repository.id !== "string"
			|| typeof value.repository.commonDirectory !== "string" || !isList(value.events)) {
			fail("factory_document_invalid", "Factory document has an invalid envelope");
		}
		value.events.forEach(eventEnvelope);
	}
	/** @param {unknown} value @returns {FactoryDocument} */
	function documentEnvelope(value) {
		assertDocumentEnvelope(value);
		return value;
	}
	/** @template {FactoryEvent} T @param {T} event @returns {T} */
	const checkEvent = (event) => {
		/** @type {Set<object>} */
		const seen = new Set();
		/** @param {unknown} value */
		const jsonData = (value) => {
			if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return;
			if (typeof value === "number" && Number.isFinite(value)) return;
			if (typeof value !== "object" || seen.has(value)
				|| (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) fail("factory_input_invalid", "Factory events require acyclic JSON data");
			seen.add(value);
			if (Array.isArray(value)) {
				for (let index = 0; index < value.length; index++) {
					if (!Object.hasOwn(value, index) || value[index] === undefined) fail("factory_input_invalid", "Factory arrays must contain explicit JSON values");
					jsonData(value[index]);
				}
			} else Object.values(value).forEach(jsonData);
			seen.delete(value);
		};
		jsonData(event);
		if (Buffer.byteLength(JSON.stringify(event)) > bounds.eventBytes) fail("factory_input_invalid", "Factory event exceeds 128 KiB");
		return event;
	};
	/** @param {FactoryDocument} document @param {boolean} [compress] */
	const encode = (document, compress = false) => {
		const raw = JSON.stringify(document);
		if (Buffer.byteLength(raw) > bounds.segmentBytes) fail("factory_segment_capacity", "A physical archive segment exceeds 32 MiB");
		if (!compress) return raw;
		const packed = JSON.stringify({ codec: "deflate-raw", data: deflateRawSync(Buffer.from(raw)).toString("base64"), digest: analysisInputDigest(document) });
		return Buffer.byteLength(packed) < Buffer.byteLength(raw) ? packed : raw;
	};
	/** @param {unknown} raw @returns {FactoryDocument} */
	const decode = (raw) => {
		try {
			if (typeof raw !== "string" || Buffer.byteLength(raw) > bounds.segmentBytes) throw new Error("Stored page exceeds its byte bound");
			const stored = parseJson(raw);
			if (!isRecord(stored) || stored.codec === undefined) return documentEnvelope(stored);
			if (stored.codec !== "deflate-raw" || typeof stored.data !== "string"
				|| Object.keys(stored).some((key) => !["codec", "data", "digest"].includes(key))) throw new Error("Invalid compression envelope");
			const bytes = Buffer.from(stored.data, "base64");
			if (bytes.toString("base64") !== stored.data) throw new Error("Invalid base64 storage encoding");
			const document = documentEnvelope(parseJson(inflateRawSync(bytes, { maxOutputLength: bounds.segmentBytes }).toString("utf8")));
			if (analysisInputDigest(document) !== stored.digest) fail("factory_document_integrity", "Compressed factory history does not match its stored content digest");
			return document;
		} catch (error) {
			if (errorCode(error) === "factory_document_integrity") throw error;
			fail("factory_document_invalid", "Factory document could not be decoded", { message: errorMessage(error) });
		}
	};
	const database = createArtifactDatabase({
		workspacePath: storageRoot ?? process.env.COPILOT_HOME ?? os.homedir(),
		directoryParts: storageRoot ? ["repositories", analysisInputDigest(repository.commonDirectory)]
			: process.env.COPILOT_HOME ? ["foundry", "repositories", analysisInputDigest(repository.commonDirectory)] : [".copilot", "foundry", "repositories", analysisInputDigest(repository.commonDirectory)],
		busyTimeoutMs, schemaVersion: STORAGE_VERSION,
		initialize(db) {
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			const application = db.prepare("PRAGMA application_id").get()?.application_id;
			if (version === STORAGE_VERSION && application === APPLICATION_ID) return;
			if (version === 3 && application === APPLICATION_ID) {
				db.exec("CREATE TABLE factory_knowledge (singleton INTEGER PRIMARY KEY CHECK(singleton=1), mode TEXT NOT NULL, head TEXT) STRICT; INSERT INTO factory_knowledge VALUES(1,'local',NULL); ALTER TABLE factory_transfers ADD COLUMN portable INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=4;");
				return;
			}
			if (version === 2 && application === APPLICATION_ID) {
				const row = db.prepare("SELECT revision, document FROM factory WHERE singleton = 1").get();
				const base = row ? decode(row.document) : empty();
				replay(base, repository);
				if (row && row.revision !== base.revision) fail("factory_revision_invalid", "Existing v2 storage metadata disagrees with its document");
				if (!row) db.prepare("INSERT INTO factory VALUES (1, 0, ?)").run(encode(base));
			} else {
				if (version !== 0 || application !== 0 || db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
					fail("factory_database_unsupported", "Factory database has an unknown schema or owner");
				}
				db.exec("CREATE TABLE factory (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL, document TEXT NOT NULL) STRICT;");
				db.prepare("INSERT INTO factory VALUES (1, 0, ?)").run(encode(empty()));
			}
			db.exec(`
				CREATE TABLE factory_head (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL) STRICT;
				INSERT INTO factory_head SELECT singleton, revision FROM factory;
				CREATE TABLE factory_events (revision INTEGER PRIMARY KEY, document TEXT NOT NULL CHECK(length(CAST(document AS BLOB)) <= ${bounds.eventBytes}), digest TEXT NOT NULL) STRICT;
				CREATE TABLE factory_archives (first_revision INTEGER PRIMARY KEY, last_revision INTEGER NOT NULL, document TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
				CREATE TABLE factory_transfers (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, digest TEXT NOT NULL, cursor INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, actor TEXT, portable INTEGER NOT NULL DEFAULT 0) STRICT;
				CREATE TABLE factory_transfer_events (transfer_id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL CHECK(length(CAST(document AS BLOB)) <= ${bounds.eventBytes}), PRIMARY KEY(transfer_id, revision)) STRICT;
				CREATE TABLE factory_knowledge (singleton INTEGER PRIMARY KEY CHECK(singleton=1), mode TEXT NOT NULL, head TEXT) STRICT;
				INSERT INTO factory_knowledge VALUES(1,'local',NULL);
				PRAGMA application_id = ${APPLICATION_ID};
				PRAGMA user_version = ${STORAGE_VERSION};
			`);
		},
	});
	/** @param {Database} db */
	const head = (db) => checkRevision(db.prepare("SELECT revision FROM factory_head WHERE singleton=1").get()?.revision, "Stored revision");
	/** @param {Database} db */
	const base = (db) => {
		const row = db.prepare("SELECT revision, document FROM factory WHERE singleton=1").get();
		if (!row) fail("factory_document_invalid", "Factory base archive is missing");
		const document = decode(row.document);
		if (document.revision !== row.revision || document.format !== format || stableStringify(document.repository) !== stableStringify(repository)
			|| !Array.isArray(document.events) || document.events.length !== document.revision) fail("factory_revision_invalid", "Factory base archive identity or revision disagrees");
		return document;
	};
	/** @param {Database} db @param {number} [throughRevision] @returns {Generator<FactoryEvent>} */
	function* events(db, throughRevision = head(db)) {
		const initial = base(db);
		if (initial.revision > head(db)) fail("factory_revision_invalid", "Factory head predates its base archive");
		let next = 1;
		for (const event of initial.events) {
			if (event.revision !== next++) fail("factory_revision_invalid", "Base events are not contiguous");
			if (event.revision <= throughRevision) yield event;
		}
		let archiveCursor = 0;
		while (true) {
			const pages = db.prepare("SELECT first_revision, last_revision, document, digest FROM factory_archives WHERE first_revision > ? ORDER BY first_revision LIMIT 32").all(archiveCursor);
			for (const page of pages) {
				if (page.first_revision !== next || Number(page.last_revision) > head(db)) fail("factory_revision_invalid", "Archive ranges have a gap, overlap or invalid head");
				const document = decode(page.document);
				if (analysisInputDigest(document) !== page.digest || document.format !== format
					|| stableStringify(document.repository) !== stableStringify(repository)
					|| !Array.isArray(document.events) || document.events.length > bounds.segmentEvents
					|| document.events.length !== Number(page.last_revision) - Number(page.first_revision) + 1
					|| document.revision !== page.last_revision) fail("factory_document_integrity", "Archive identity, range or digest is invalid");
				for (const event of document.events) {
					if (event.revision !== next++) fail("factory_revision_invalid", "Archived events are not contiguous");
					if (event.revision <= throughRevision) yield event;
				}
				archiveCursor = Number(page.first_revision);
			}
			if (pages.length < 32) break;
		}
		let cursor = next - 1;
		while (cursor < throughRevision) {
			const rows = db.prepare("SELECT revision, document, digest FROM factory_events WHERE revision > ? AND revision <= ? ORDER BY revision LIMIT 256").all(cursor, throughRevision);
			if (!rows.length) fail("factory_revision_invalid", "Factory history has a missing event");
			for (const row of rows) {
				let event;
				try { event = parseJson(String(row.document)); }
				catch (error) { fail("factory_document_invalid", "Stored event is not valid JSON", { message: errorMessage(error) }); }
				eventEnvelope(event);
				if (row.revision !== next++ || event.revision !== row.revision || analysisInputDigest(event) !== row.digest) fail("factory_document_integrity", "Event identity, order or digest is invalid");
				checkEvent(event);
				yield event;
				cursor = Number(row.revision);
			}
		}
		if (throughRevision > head(db)) fail("factory_revision_invalid", "Pinned revision is not present");
	}
	/** @param {Database} db */
	const read = (db) => {
		const revision = head(db);
		const document = { format, repository, revision, events: [...events(db, revision)], ...(base(db).portable ? { portable: /** @type {const} */ (true) } : {}) };
		return { document, state: replay(document, repository) };
	};
	/** @param {Database} db */
	const storedBytes = (db) => Number(db.prepare(`SELECT
		COALESCE((SELECT sum(length(CAST(document AS BLOB))) FROM factory),0) +
		COALESCE((SELECT sum(length(CAST(document AS BLOB))) FROM factory_events),0) +
		COALESCE((SELECT sum(length(CAST(document AS BLOB))) FROM factory_archives),0) AS bytes`).get()?.bytes ?? 0);
	/** @param {Database} db @param {boolean} [force] */
	const archive = (db, force = false) => {
		const statistics = db.prepare("SELECT count(*) AS count, COALESCE(sum(length(CAST(document AS BLOB))),0) AS bytes FROM factory_events").get();
		if (!force && Number(statistics?.count) < bounds.segmentEvents && Number(statistics?.bytes) < bounds.segmentBytes) return;
		let cursor = 0;
		while (true) {
			const rows = db.prepare("SELECT revision, document FROM factory_events WHERE revision > ? ORDER BY revision LIMIT ?").all(cursor, bounds.segmentEvents);
			if (!rows.length) break;
			/** @type {FactoryEvent[]} */
			const selected = [];
			let bytes = Buffer.byteLength(JSON.stringify({ format, repository, revision: head(db), events: [] }));
			for (const row of rows) {
				const size = Buffer.byteLength(String(row.document)) + 1;
				if (bytes + size > bounds.segmentBytes) break;
				const event = parseJson(String(row.document));
				eventEnvelope(event);
				selected.push(event);
				bytes += size;
			}
			if (!selected.length) fail("factory_segment_capacity", "An event cannot fit a bounded archive page");
			const first = selected[0].revision;
			const last = selected[selected.length - 1].revision;
			const document = { format, repository, revision: last, events: selected };
			db.prepare("INSERT INTO factory_archives VALUES (?, ?, ?, ?)").run(first, last, encode(document, true), analysisInputDigest(document));
			const removed = db.prepare("DELETE FROM factory_events WHERE revision BETWEEN ? AND ?").run(first, last);
			if (Number(removed.changes) !== selected.length) fail("factory_revision_invalid", "Archive relocation did not retain the exact event range");
			cursor = last;
			if (!force) break;
		}
		if (force) {
			const initial = base(db);
			db.prepare("UPDATE factory SET document=? WHERE singleton=1").run(encode(initial, true));
		}
	};
	/** @param {Database} db @param {unknown} expectedRevision */
	const assertUnused = (db, expectedRevision) => {
		if (expectedRevision !== 0 || head(db) !== 0) fail("factory_import_conflict", "Import requires empty authority and expectedRevision 0");
	};
	/** @template {FactoryAction} A @param {A} action @param {Record<string, unknown>} request
	 * @param {((document: FactoryDocument, state: import("../types/factory.js").FactoryState) => void)} [validate]
	 * @returns {import("../types/factory.js").FactoryMutationResult<A>} */
	const append = (action, request, validate) => database.transaction((db) => {
		if (db.prepare("SELECT id FROM factory_transfers WHERE status='pending' LIMIT 1").get()) fail("factory_import_pending", "Complete or explicitly abandon the staged import before appending authority");
		const { document, state } = read(db);
		if (checkRevision(request?.expectedRevision, "expectedRevision") !== document.revision) fail("revision_conflict", "Repository factory has changed", { expectedRevision: request.expectedRevision, latestRevision: document.revision });
		let owned;
		try { owned = structuredClone(request); } catch (error) { fail("factory_input_invalid", "Factory mutations require owned JSON data", { message: errorMessage(error) }); }
		const { expectedRevision, ...payload } = owned;
		const input = prepareCommand(action, payload);
		const at = now();
		const last = document.events.at(-1);
		if (last && last.at > at) fail("factory_clock_invalid", "Factory clock moved behind its last event");
		const event = checkEvent({ revision: checkRevision(document.revision + 1, "next revision"), at, action, input });
		const result = applyEvent(state, event);
		if ("idempotent" in result && result.idempotent) return structuredClone({ repository, revision: document.revision, ...result });
		validate?.({ ...document, revision: event.revision, events: [...document.events, event] }, state);
		const serialized = JSON.stringify(event);
		const before = action === "compactFactory" ? storedBytes(db) : null;
		db.prepare("INSERT INTO factory_events VALUES (?, ?, ?)").run(event.revision, serialized, analysisInputDigest(parseJson(serialized)));
		db.prepare("UPDATE factory_head SET revision=? WHERE singleton=1").run(event.revision);
		archive(db, action === "compactFactory");
		return structuredClone({
			repository, revision: event.revision, ...result,
			...(action === "compactFactory" ? { storage: { encoding: "segmented-records", previousDocumentBytes: before, documentBytes: storedBytes(db), fileSizeMayNotShrink: true } } : {})
		});
	}, { write: true });
	const snapshot = () => database.transaction((db) => {
		const { document, state } = read(db);
		return { repository, revision: document.revision, ...state };
	});
	const readDocument = () => database.transaction((db) => structuredClone(read(db).document));
	/** @param {import("../types/factory.js").FactoryReceipt[]} receipts */
	const preview = (receipts) => database.transaction((db) => {
		const { document, state } = read(db);
		for (const [index, receipt] of receipts.entries()) applyEvent(state, checkEvent({
			revision: document.revision + index + 1, at: now(), action: receipt.action, input: prepareCommand(receipt.action, structuredClone(receipt.input)),
		}));
		return { revision: document.revision, valid: true };
	});
	const exportFactory = () => database.transaction((db) => {
		const serialized = JSON.stringify(read(db).document);
		if (Buffer.byteLength(serialized) > bounds.jsonBytes) fail("factory_export_page_required", "Logical history exceeds the 32 MiB single-JSON bound; use pinned factory export pages");
		return serialized;
	});
	/** @param {{afterRevision?: number, throughRevision?: number, throughDigest?: string, limit?: number}} [input] */
	const exportFactoryPage = ({ afterRevision = 0, throughRevision, throughDigest, limit = bounds.transferEvents } = {}) => database.transaction((db) => {
		checkRevision(afterRevision, "afterRevision");
		const revision = throughRevision ?? head(db);
		checkRevision(revision, "throughRevision");
		if (revision > head(db) || afterRevision > revision || !Number.isSafeInteger(limit) || limit < 1 || limit > bounds.transferEvents) fail("factory_export_cursor", "Invalid bounded export cursor");
		const selected = [];
		let digest = analysisInputDigest({ ...empty(), ...(base(db).portable ? { portable: true } : {}) });
		let bytes = 0;
		let full = false;
		for (const event of events(db, revision)) {
			digest = analysisInputDigest([digest, analysisInputDigest(event)]);
			const size = Buffer.byteLength(JSON.stringify(event));
			if (event.revision > afterRevision && !full) {
				if (selected.length >= limit || bytes + size >= bounds.transferBytes - 8192) full = true;
				else { selected.push(event); bytes += size; }
			}
		}
		if (throughDigest !== undefined && throughDigest !== digest) fail("factory_export_changed", "Pinned logical export identity changed");
		const nextRevision = selected.at(-1)?.revision ?? afterRevision;
		return { format, repository, revision, throughDigest: digest, afterRevision, events: selected, nextRevision, complete: nextRevision === revision,
			...(base(db).portable ? { portable: /** @type {const} */ (true) } : {}) };
	});
	/** @param {{source: unknown, expectedRevision: unknown}} input */
	const importFactory = ({ source, expectedRevision }) => database.transaction((db) => {
		assertUnused(db, expectedRevision);
		if (db.prepare("SELECT id FROM factory_transfers WHERE status='pending' LIMIT 1").get()) fail("factory_import_pending", "A paged import is already pending");
		let document;
		try {
			if (typeof source !== "string" || Buffer.byteLength(source) > bounds.jsonBytes) fail("factory_import_invalid", "Use current-format JSON up to 32 MiB or staged import pages");
			document = documentEnvelope(parseJson(source));
		} catch (error) {
			if (errorCode(error)) throw error;
			fail("factory_import_invalid", "Factory import contains invalid JSON");
		}
		replay(document, repository);
		const last = document.events.at(-1);
		if (last && last.at > now()) fail("factory_import_invalid", "Factory import contains future events");
		document.events.forEach(checkEvent);
		db.prepare("UPDATE factory SET revision=?,document=? WHERE singleton=1").run(document.revision, encode(document));
		db.prepare("UPDATE factory_head SET revision=? WHERE singleton=1").run(document.revision);
		return { repository, revision: document.revision, imported: true, executionOwnership: "not-transferred" };
	}, { write: true });
	/** @param {{importId: string, page: unknown, expectedRevision: unknown}} input */
	const importFactoryPage = ({ importId, page, expectedRevision }) => database.transaction((db) => {
		assertUnused(db, expectedRevision);
		if (typeof importId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(importId)) fail("factory_import_invalid", "A stable importId is required");
		if (!isRecord(page) || page.format !== format || stableStringify(page.repository) !== stableStringify(repository)
			|| !isList(page.events) || page.events.length > bounds.transferEvents
			|| (page.portable !== undefined && page.portable !== true)
			|| Buffer.byteLength(JSON.stringify(page)) > bounds.transferBytes
			|| typeof page.throughDigest !== "string" || !/^[a-f0-9]{64}$/.test(page.throughDigest)) fail("factory_import_invalid", "Invalid bounded current-format export page");
		const pageRevision = checkRevision(page.revision, "import head");
		const afterRevision = checkRevision(page.afterRevision, "import cursor");
		let transfer = db.prepare("SELECT revision,digest,cursor,status,portable FROM factory_transfers WHERE id=?").get(importId);
		if (!transfer) {
			if (page.afterRevision !== 0 || db.prepare("SELECT id FROM factory_transfers WHERE status='pending' LIMIT 1").get()) fail("factory_import_cursor", "Start one import from revision zero");
			db.prepare("INSERT INTO factory_transfers VALUES (?, ?, ?, 0, 'pending', NULL, NULL, ?)").run(importId, pageRevision, page.throughDigest, Number(page.portable === true));
			transfer = { revision: pageRevision, digest: page.throughDigest, cursor: 0, status: "pending", portable: Number(page.portable === true) };
		}
		if (transfer.status !== "pending" || transfer.revision !== page.revision || transfer.digest !== page.throughDigest
			|| transfer.cursor !== page.afterRevision || transfer.portable !== Number(page.portable === true)) fail("factory_import_cursor", "Import page does not follow its pinned staged prefix");
		/** @type {FactoryEvent[]} */
		const prior = [];
		let stagedCursor = 0;
		while (true) {
			const rows = db.prepare("SELECT revision,document FROM factory_transfer_events WHERE transfer_id=? AND revision>? ORDER BY revision LIMIT 256").all(importId, stagedCursor);
			for (const row of rows) {
				const event = parseJson(String(row.document));
				eventEnvelope(event);
				prior.push(event);
				stagedCursor = Number(row.revision);
			}
			if (rows.length < 256) break;
		}
		const incoming = page.events.map((event) => { eventEnvelope(event); return event; });
		const combined = [...prior, ...incoming];
		const cursor = combined.length;
		if (cursor > pageRevision || page.nextRevision !== cursor || page.complete !== (cursor === pageRevision)
			|| (!page.events.length && cursor !== page.revision)) fail("factory_import_cursor", "Import page has a gap, duplicate or invalid completion marker");
		const document = { format, repository, revision: cursor, events: combined, ...(page.portable ? { portable: /** @type {const} */ (true) } : {}) };
		replay(document, repository);
		const last = combined.at(-1);
		if (last && last.at > now()) fail("factory_import_invalid", "Imported evidence is from the future");
		for (const event of incoming) {
			checkEvent(event);
			db.prepare("INSERT INTO factory_transfer_events VALUES (?, ?, ?)").run(importId, event.revision, JSON.stringify(event));
		}
		db.prepare("UPDATE factory_transfers SET cursor=? WHERE id=?").run(cursor, importId);
		if (!page.complete) return { importId, revision: 0, stagedRevision: cursor, complete: false };
		const digest = historyDigest(combined, page.portable === true);
		if (digest !== page.throughDigest) fail("factory_import_invalid", "Completed import differs from the pinned export head");
		for (const event of combined) db.prepare("INSERT INTO factory_events VALUES (?, ?, ?)").run(event.revision, JSON.stringify(event), analysisInputDigest(event));
		if (page.portable) db.prepare("UPDATE factory SET document=? WHERE singleton=1").run(encode({ ...empty(), portable: true }));
		db.prepare("UPDATE factory_head SET revision=? WHERE singleton=1").run(cursor);
		db.prepare("UPDATE factory_transfers SET status='completed' WHERE id=?").run(importId);
		archive(db, true);
		return { importId, repository, revision: cursor, stagedRevision: cursor, complete: true, executionOwnership: "not-transferred" };
	}, { write: true });
	/** @param {{importId: string, expectedRevision: unknown, actor: string, reason: string}} input */
	const abandonFactoryImport = ({ importId, expectedRevision, actor, reason }) => database.transaction((db) => {
		assertUnused(db, expectedRevision);
		if (typeof actor !== "string" || !actor.trim() || actor.length > 256 || typeof reason !== "string" || !reason.trim() || reason.length > 8000) fail("factory_import_invalid", "Abandonment needs actor and reason");
		const changed = db.prepare("UPDATE factory_transfers SET status='abandoned',actor=?,reason=? WHERE id=? AND status='pending'").run(actor, reason, importId);
		if (changed.changes !== 1) fail("factory_import_missing", "No pending import has this identity");
		return { importId, abandoned: true, stagedHistoryRetained: true };
	}, { write: true });
	const storageInfo = () => database.transaction((db) => ({
		version: STORAGE_VERSION, model: "bounded-records-and-archives", revision: head(db),
		baseEvents: Number(db.prepare("SELECT revision FROM factory WHERE singleton=1").get()?.revision ?? 0),
		hotEvents: Number(db.prepare("SELECT count(*) AS count FROM factory_events").get()?.count ?? 0),
		archiveSegments: Number(db.prepare("SELECT count(*) AS count FROM factory_archives").get()?.count ?? 0),
		limits: bounds, lifetimeEventCeiling: null,
		transfers: db.prepare("SELECT id,revision,cursor,status,actor,reason FROM factory_transfers ORDER BY rowid DESC LIMIT 50").all(),
	}));
	const knowledgeMetadata = () => database.transaction((db) => {
		const row = db.prepare("SELECT mode,head FROM factory_knowledge WHERE singleton=1").get();
		if (!row || (row.mode !== "local" && row.mode !== "repository")
			|| (row.head !== null && (typeof row.head !== "string" || !/^[a-f0-9]{64}$/.test(row.head)))) fail("factory_document_invalid", "Factory knowledge cache metadata is invalid");
		return { mode: row.mode, head: row.head };
	});
	/** @param {{mode: "local" | "repository", head: string | null}} input */
	const setKnowledgeMetadata = (input) => database.transaction((db) => {
		if (!["local", "repository"].includes(input.mode) || (input.head !== null && !/^[a-f0-9]{64}$/.test(input.head))) fail("factory_input_invalid", "Invalid knowledge cache head");
		db.prepare("UPDATE factory_knowledge SET mode=?,head=? WHERE singleton=1").run(input.mode, input.head);
	}, { write: true });
	return { databasePath: database.databasePath, append, snapshot, preview, readDocument, exportFactory, importFactory, exportFactoryPage, importFactoryPage, abandonFactoryImport, storageInfo,
		knowledgeMetadata, setKnowledgeMetadata };
}
