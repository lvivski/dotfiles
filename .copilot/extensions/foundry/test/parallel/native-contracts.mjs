import assert, { AssertionError } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isList, isRecord, parseJson } from "../../data.mjs";

/** Actual owner-offered schema capture, not a synthetic SDK or successful transport.
 * @param {string} name */
export function offeredSchema(name) {
	const captured = parseJson(readFileSync(new URL("fixtures/native-tools.json", import.meta.url), "utf8"));
	assert.ok(isRecord(captured) && isList(captured.tools));
	const entry = captured.tools.find((entry) => isRecord(entry) && entry.name === name);
	assert.ok(isRecord(entry) && isRecord(entry.input_schema), `Tool was not offered: ${name}`);
	return entry.input_schema;
}

/** @param {unknown} schema @param {unknown} value @param {string} [location] */
function matches(schema, value, location = "arguments") {
	assert.ok(isRecord(schema), `${location}: schema object required`);
	/** @param {unknown} candidate */
	const accepts = (candidate) => {
		try { matches(candidate, value, location); return true; }
		catch (error) { if (error instanceof AssertionError) return false; throw error; }
	};
	if (isList(schema.oneOf)) assert.equal(schema.oneOf.filter(accepts).length, 1, `${location}: oneOf`);
	if (isList(schema.anyOf)) assert.ok(schema.anyOf.some(accepts), `${location}: anyOf`);
	if (isList(schema.allOf)) for (const branch of schema.allOf) matches(branch, value, location);
	if (schema.not !== undefined) assert.ok(!accepts(schema.not), `${location}: not`);
	if (schema.if !== undefined) {
		const branch = accepts(schema.if) ? schema.then : schema.else;
		if (branch !== undefined) matches(branch, value, location);
	}
	if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${location}: const`);
	if (isList(schema.enum)) assert.ok(schema.enum.some(item => item === value), `${location}: enum`);
	const kinds = isList(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
	if (kinds.length) assert.ok(kinds.some(kind => kind === "null" ? value === null
		: kind === "array" ? isList(value) : kind === "object" ? isRecord(value)
		: kind === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
		: typeof value === kind), `${location}: type`);
	if (typeof value === "string") {
		if (typeof schema.minLength === "number") assert.ok(value.length >= schema.minLength, `${location}: minLength`);
		if (typeof schema.maxLength === "number") assert.ok(value.length <= schema.maxLength, `${location}: maxLength`);
		if (typeof schema.pattern === "string") assert.match(value, new RegExp(schema.pattern), `${location}: pattern`);
	}
	if (typeof value === "number") {
		assert.ok(Number.isFinite(value), `${location}: finite number`);
		if (typeof schema.minimum === "number") assert.ok(value >= schema.minimum, `${location}: minimum`);
		if (typeof schema.maximum === "number") assert.ok(value <= schema.maximum, `${location}: maximum`);
		if (typeof schema.exclusiveMinimum === "number") assert.ok(value > schema.exclusiveMinimum, `${location}: exclusiveMinimum`);
	}
	if (isList(value)) {
		if (typeof schema.minItems === "number") assert.ok(value.length >= schema.minItems, `${location}: minItems`);
		if (typeof schema.maxItems === "number") assert.ok(value.length <= schema.maxItems, `${location}: maxItems`);
		if (schema.items !== undefined) value.forEach((item, index) => matches(schema.items, item, `${location}[${index}]`));
	}
	if (isRecord(value)) {
		if (isList(schema.required)) for (const key of schema.required) {
			assert.ok(typeof key === "string" && Object.hasOwn(value, key), `${location}: required ${key}`);
		}
		const properties = isRecord(schema.properties) ? schema.properties : {};
		for (const [key, item] of Object.entries(value)) {
			if (Object.hasOwn(properties, key)) matches(properties[key], item, `${location}.${key}`);
			else assert.notEqual(schema.additionalProperties, false, `${location}: unknown ${key}`);
		}
	}
}

/** Fixture conformance against captured actual requests. Not permission, result, event or host execution evidence.
 * @param {string} name @param {unknown} args */
export function assertOfferedToolArguments(name, args) {
	matches(offeredSchema(name), args, name);
}
