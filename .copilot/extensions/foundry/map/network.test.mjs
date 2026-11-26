import assert from "node:assert/strict";
import test from "node:test";
import {example} from "./model.mjs";
import {network,purpose} from "./network.mjs";

test("selection traces real transitive inputs and consumers, not every sibling of a shared producer",()=>{
	const work=network(example.nodes);
	assert.deepEqual(work.trace("export-results").up,new Set(["file-reader","csv-format","catalog-format"]));
	assert.deepEqual(work.trace("file-reader").down,new Set(["export-results","search-command"]));
	assert.ok(!work.trace("file-reader").ids.has("csv-format"));
	assert.deepEqual(work.find("SRC/READER","assigned").map(n=>n.id),["file-reader"]);
	assert.deepEqual(work.find("csv","blocked"),[]);
});

test("assignment purpose comes from the declared behavior or its specification, not an inferred dependency",()=>{
	const n={...example.nodes[0],task:"",reason:"External resource is busy.",needs:[]};
	assert.equal(purpose(example.nodes[0]),example.nodes[0].task);
	assert.match(purpose({...n,specification:"spec/reader.md"}),/spec\/reader\.md/);
	assert.match(purpose(n),/No purpose is recorded/);
	assert.equal(network([n]).trace(n.id).up.size,0);
});

test("search, partial visibility and a passing rerun cannot create a checked prerequisite",()=>{
	const producer={...example.nodes[3],passedOnBuild:"rerun-2"},consumer=example.nodes[5];
	const work=network([producer,consumer]);
	assert.equal(work.state(producer),"passed");assert.equal(work.state(consumer),"waiting");
	assert.deepEqual(work.missing(consumer),["file-reader","search-index"]);
	assert.deepEqual(work.find("search-command","waiting").map(n=>n.id),[consumer.id]);
	assert.deepEqual(work.trace(consumer.id).up,new Set([producer.id]));
});

test("status counts use the visible assignments' display states, including queues and unintegrated reruns",()=>{
	const [source]=example.nodes;
	const queued={...source,id:"queued-item",state:"waiting",needs:[source.id]},blocked={...source,id:"stop",state:"blocked",checked:null};
	const rerun={...blocked,id:"observed",passedOnBuild:"rerun"};
	const work=network([source,queued,blocked,rerun,{...queued,id:"another-item"}]);
	assert.deepEqual(work.summary().map(s=>[s.key,s.text]),[
		["blocked","1 blocked"],["queued","2 queued"],["passed","1 passed on build · not integrated"],["published","1 component checked"],
	]);
	assert.deepEqual(network([queued]).summary().map(s=>s.text),["1 waiting for input"]);
	assert.deepEqual(network([]).summary(),[]);
});
