/**
 * Browser renderer for the Foundry loopback canvas.
 *
 * @module foundry/renderer
 */
/**
 * Requires an HTML element that must exist in the static renderer template.
 *
 * @param {string} selector
 * @returns {HTMLElement}
 */
function requiredElement(selector) {
	const node = document.querySelector(selector);
	if (!(node instanceof HTMLElement)) {
		throw new Error(`Missing required renderer element: ${selector}`);
	}
	return node;
}

/**
 * Requires a metadata element embedded by the loopback server.
 *
 * @param {string} selector
 * @returns {HTMLMetaElement}
 */
function requiredMeta(selector) {
	const node = document.querySelector(selector);
	if (!(node instanceof HTMLMetaElement)) {
		throw new Error(`Missing required renderer metadata: ${selector}`);
	}
	return node;
}

/**
 * Creates a DOM element and assigns text through `textContent`.
 *
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} className
 * @param {unknown} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = String(text);
	return node;
}

/**
 * Adds a labeled row when the value is present.
 *
 * @param {HTMLElement} parent
 * @param {string} label
 * @param {unknown} value
 * @returns {void}
 */
function addLabeledValue(parent, label, value) {
	if (value === null || value === undefined || value === "") return;
	const row = element("div", "detail-row");
	row.append(element("strong", "", `${label}: `));
	row.append(document.createTextNode(String(value)));
	parent.append(row);
}

export { addLabeledValue, element, requiredElement, requiredMeta };
