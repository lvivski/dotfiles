import assert from "node:assert/strict";
import test from "node:test";
import { replacement } from "./resolution.mjs";

test("an exact replacement preserves adjacent checkpoint edits and original line endings",()=>{
	const base="Heading\r\nold paragraph\r\nTail", target="Heading\r\nnew paragraph\r\nTail";
	const checked="Different heading\r\nold paragraph\r\nExtra\r\nTail";
	assert.equal(replacement(base,checked,target,"notes").result,"Different heading\r\nnew paragraph\r\nExtra\r\nTail");
	for (const conflict of [
		"Different heading\r\nold paragraph\r\nold paragraph\r\nTail",
		"Different heading\r\nmodified old paragraph\r\nTail",
		"new paragraph\r\nold paragraph\r\nTail",
	]) assert.throws(()=>replacement(base,conflict,target,"notes"),/unique whole-line resolution/);
});
