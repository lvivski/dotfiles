import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { declaredInterface } from "./interface.mjs";

test("the registered extension and ordered statecharts match the independent regeneration contract",async()=>{
	const expected = JSON.parse(await readFile(new URL("../spec/interface.json",import.meta.url),"utf8"));
	assert.deepEqual(await declaredInterface(),expected);
});
