import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule } from "node:vm";
import { parseJson, readRecord } from "../../data.mjs";
import { RENDERER_SCRIPTS } from "../../server/assets.mjs";
import { must } from "../assertions.mjs";

/** @typedef {(event?: BrowserEvent) => unknown} BrowserListener */
/** @typedef {{method?: string, headers?: Record<string, string>, body?: string}} BrowserRequestOptions */
/** @typedef {{url: string, options: BrowserRequestOptions, reject: (error?: unknown) => void, reply: (payload: unknown, status?: number) => void}} BrowserRequest */
/** @typedef {{currentTarget?: Element, data?: string}} BrowserEvent */

/** @param {BrowserRequest} request */
export const posted = (request) => readRecord(parseJson(must(request.options.body)));

export const rendererRoot = new URL("../../renderer/", import.meta.url);

const sources = await Promise.all(RENDERER_SCRIPTS.map(async (name) => ({
	url: new URL(name, rendererRoot).href,
	source: await readFile(new URL(name, rendererRoot), "utf8"),
})));

const template = await readFile(new URL("../../renderer/index.html", import.meta.url), "utf8");

export const flush = () => new Promise((resolve) => setImmediate(resolve));

// Only the board's DOM operations; modules execute without transpilation in an isolated realm.
class Element {
	constructor(tag = "div") {
		this.tagName = tag;
		/** @type {Array<Element | string>} */
		this.childNodes = [];
		this.hidden = false;
		this.content = "";
		/** @type {Record<string, string>} */
		this.attributes = {};
		/** @type {Map<string, BrowserListener>} */
		this.listeners = new Map();
		/** @type {Element | null} */
		this.parentElement = null;
		this.className = "";
		this.type = "";
		this.open = false;
		this.scrollTop = 0;
		/** @type {{activeElement: Element | null} | null} */
		this.ownerDocument = null;
	}
	/** @param {string} value */
	set textContent(value) { this.replaceChildren(String(value)); }
	/** @returns {string} */
	get textContent() {
		return this.childNodes.map((child) => typeof child === "string" ? child : child.textContent).join("");
	}
	/** @returns {Element[]} */
	get children() { return this.childNodes.filter((child) => child instanceof Element); }
	get disabled() { return "disabled" in this.attributes; }
	/** @param {boolean} value */
	set disabled(value) { if (value) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
	/** @param {Array<Element | string>} children */
	append(...children) {
		for (const child of children) {
			if (child instanceof Element) { child.remove(); child.parentElement = this; }
			this.childNodes.push(child);
		}
	}
	/** @param {Array<Element | string>} children */
	replaceChildren(...children) {
		for (const child of this.children) child.parentElement = null;
		this.childNodes = [];
		this.append(...children);
	}
	/** @param {Element} child @param {Element | null} reference */
	insertBefore(child, reference) {
		child.remove();
		const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
		this.childNodes.splice(index, 0, child);
		child.parentElement = this;
	}
	remove() {
		if (this.parentElement) {
			this.parentElement.childNodes = this.parentElement.childNodes.filter((child) => child !== this);
			this.parentElement = null;
		}
	}
	/** @param {string} name @param {string} value */
	setAttribute(name, value) { this.attributes[name] = value; }
	/** @param {string} name */
	removeAttribute(name) { delete this.attributes[name]; }
	/** @param {string} name @param {BrowserListener} listener */
	addEventListener(name, listener) { this.listeners.set(name, listener); }
	click() { if (!this.disabled) return this.listeners.get("click")?.({ currentTarget: this }); }
	/** @param {boolean} open */
	toggle(open) { this.open = open; return this.listeners.get("toggle")?.(); }
	focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
}

export async function browser(planId = "renderer-plan") {
	const elements = new Map([...template.matchAll(/id="([^"]+)"/g)]
		.map((match) => [`#${match[1]}`, new Element()]));
	for (const [name, content] of [["plan-id", planId], ["token", `token-${planId}`]]) {
		const meta = new Element("meta");
		meta.content = content;
		elements.set(`meta[name="foundry-${name}"]`, meta);
	}
	const nodes = {
		/** @param {string} selector */
		get(selector) {
			const node = elements.get(selector);
			assert.ok(node, `Missing test element ${selector}`);
			return node;
		},
	};
	nodes.get("#approve-button").hidden = true;
	nodes.get("#cancel-plan-button").hidden = true;
	/** @type {BrowserRequest[]} */
	const requests = [];
	/** @type {Map<string, BrowserListener>} */
	const listeners = new Map();
	/** @type {string[]} */
	const confirmations = [];
	/** @type {string[]} */
	const prompts = [];
	/** @type {Map<number, {callback: () => unknown, delay: number}>} */
	const timers = new Map();
	let timerId = 0;
	const window = {
		prompt: (/** @type {string} */ message) => { prompts.push(message); return "  tester  "; },
		confirm: (/** @type {string} */ message) => { confirmations.push(message); return true; },
		addEventListener: (/** @type {string} */ name, /** @type {BrowserListener} */ listener) => listeners.set(`window:${name}`, listener),
	};
	const events = {
		addEventListener: (/** @type {string} */ name, /** @type {BrowserListener} */ listener) => listeners.set(name, listener),
		onerror: () => { },
		closeCount: 0,
		close() { this.closeCount++; },
	};
	const document = {
		hidden: false,
		/** @type {Element | null} */
		activeElement: null,
		querySelector: (/** @type {string} */ selector) => nodes.get(selector),
		createElement: (/** @type {string} */ tag) => Object.assign(new Element(tag), { ownerDocument: document }),
		createTextNode: (/** @type {string} */ text) => text,
		addEventListener: (/** @type {string} */ name, /** @type {BrowserListener} */ listener) => listeners.set(`document:${name}`, listener),
	};
	const context = createContext({
		HTMLElement: Element,
		HTMLMetaElement: Element,
		document,
		window,
		URLSearchParams,
		setTimeout: (/** @type {() => unknown} */ callback, /** @type {number} */ delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
		clearTimeout: (/** @type {number} */ id) => timers.delete(id),
		crypto: { randomUUID: () => "cancel-request" },
		EventSource: class {
			/** @param {string} url */
			constructor(url) { assert.equal(url, "events"); return events; }
		},
		/** @param {string} url @param {BrowserRequestOptions} [options] */
		fetch: (url, options = {}) => new Promise((resolve, reject) => {
			requests.push({
				url, options, reject,
				reply: (payload, status = 200) => resolve({
					ok: status === 200, status, json: async () => structuredClone(payload),
				}),
			});
		}),
	});
	const modules = new Map(sources.map(({ url, source }) => [
		url, new SourceTextModule(source, { context, identifier: url }),
	]));
	const entry = must(modules.get(new URL("app.mjs", rendererRoot).href));
	const loaded = new Set([entry.identifier]);
	await entry.link((specifier, referencing) => {
		const url = new URL(specifier, referencing.identifier).href;
		loaded.add(url);
		return must(modules.get(url), `Renderer import is not a served asset: ${url}`);
	});
	await entry.evaluate();
	return {
		nodes, requests, window, document, events, confirmations, prompts, timers, loaded,
		change: () => must(listeners.get("change"))({ data: JSON.stringify({ planId }) }),
		ready: () => must(listeners.get("ready"))(),
		/** @param {boolean} hidden */
		setHidden(hidden) {
			document.hidden = hidden;
			must(listeners.get("document:visibilitychange"))();
		},
		hidePage: () => must(listeners.get("window:pagehide"))(),
		showPage: () => must(listeners.get("window:pageshow"))(),
		tick() {
			const [id, timer] = must(timers.entries().next().value, "No live refresh timer");
			timers.delete(id);
			return timer.callback();
		},
		/** @param {number} index @param {unknown} value */
		async respond(index, value) {
			requests[index].reply({ ok: true, value });
			await flush();
		},
	};
}

/** @param {Element} node @returns {Element[]} */
export function buttons(node) {
	if (node.hidden) return [];
	return node.childNodes.flatMap((child) => typeof child === "string"
		? [] : [...(child.tagName === "button" ? [child] : []), ...buttons(child)]);
}

/** @param {Element} node @returns {Element[]} */
export function disclosures(node) {
	return node.childNodes.flatMap((child) => typeof child === "string"
		? [] : [...(child.tagName === "details" ? [child] : []), ...disclosures(child)]);
}
