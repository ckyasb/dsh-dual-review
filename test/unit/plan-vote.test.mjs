// Unit tests for the v0.6.0 plan-review vote: requiredApprovals 1 approves on
// one approve (merging the revising reviewer's blockers), failures and two
// revises still fall back, and requiredApprovals 2 keeps the v0.5.2 text.
// The reviewers are stubbed by replacing globalThis.fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply } from "../../lib/index.js";

const reviewer = (name, model) => ({ name, baseURL: "http://reviewer.unit/v1", apiKeyEnv: "DUAL_REVIEW_UNIT_KEY", model });

function stubFetch() {
	const calls = [];
	const stub = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push(body.model);
		const kind = body.messages[0].content.split("\n", 1)[0];
		const text = body.model.includes("fail") ? null
			: kind === "PLAN_REVIEW_POLICY" ? body.model.includes("revise") ? JSON.stringify({ verdict: "revise", blockers: ["缺少备份步骤"], additions: ["先做快照"] }) : JSON.stringify({ verdict: "approve", blockers: [], additions: ["执行后验证结果"] })
			: JSON.stringify({ decision: "allow" });
		if (text === null) return { ok: false, status: 500, text: async () => "mock failure" };
		return {
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { role: "assistant", content: text } }] })
		};
	};
	return { stub, calls };
}

const planReview = { enabled: true, maxRevisions: 2 };

function mount(config) {
	const hooks = new Map();
	const ctx = {
		permissionPresets: { registerAuto: () => () => {}, current: () => "workspace-write" },
		logger: { info() {}, warn() {} },
		get: (key) => ({ planMode: { get: () => ({ active: true }), set: () => "committed" } })[key],
		on: (event, handler) => {
			hooks.set(event, [...hooks.get(event) ?? [], handler]);
			return () => {};
		},
		effect: (body) => {
			const steps = body();
			while (!steps.next().done);
		},
		workingDirectory: { ensure: async () => "/tmp" },
		sessions: { list: () => [] }
	};
	apply(ctx, config);
	const execute = hooks.get("tools/execute")[0];
	assert.equal(typeof execute, "function", "one tools/execute hook");
	return execute;
}

const session = { header: {}, snapshotEvents: () => [], surface: { nodes: [] }, requestHeader: () => void 0 };
const agent = { session };
const submit = (execute) => execute({ name: "exit_plan_mode", agent, arguments: { plan: "# P\n" }, signal: new AbortController().signal }, async () => {
	throw new Error("DSH's plan-approval question must not open");
});

const run = async (config, action) => {
	const { stub, calls } = stubFetch();
	const previous = globalThis.fetch;
	const previousKey = process.env["DUAL_REVIEW_UNIT_KEY"];
	process.env["DUAL_REVIEW_UNIT_KEY"] = "test-key";
	globalThis.fetch = stub;
	try {
		return { value: await action(mount(config)), calls };
	} finally {
		globalThis.fetch = previous;
		if (previousKey === void 0) delete process.env["DUAL_REVIEW_UNIT_KEY"];
		else process.env["DUAL_REVIEW_UNIT_KEY"] = previousKey;
	}
};

test("requiredApprovals 1: one approve and one revise approve, merging the revise blockers", async () => {
	const config = { reviewers: [reviewer("R1", "approve"), reviewer("R2", "revise")], requiredApprovals: 1, planReview };
	const { value, calls } = await run(config, submit);
	assert.equal(value.isError, false);
	assert.deepEqual(value.value, { approved: true });
	const text = value.additionalContexts[0].content[0].text;
	assert.match(text, /计划审查通过（R1：通过；R2：要求修改——其意见已并入补充项；需要 1 票，执行模型计 1 票）。/);
	assert.match(text, /缺少备份步骤（R2）/);
	assert.match(text, /执行后验证结果（R1）/);
	assert.match(text, /现在开始执行/);
	assert.equal(calls.length, 2);
});

test("requiredApprovals 1: two revises still ask for revisions, approve plus failure approves", async () => {
	const config = { reviewers: [reviewer("R1", "revise"), reviewer("R2", "revise")], requiredApprovals: 1, planReview };
	await assert.rejects(run(config, submit), (error) => {
		assert.match(error.message, /要求修改计划（第 1\/2 轮）/);
		assert.match(error.message, /缺少备份步骤/);
		return true;
	});
	const mixed = { reviewers: [reviewer("R1", "approve"), reviewer("R2", "fail")], requiredApprovals: 1, planReview };
	const { value } = await run(mixed, submit);
	assert.deepEqual(value.value, { approved: true }, "the failure cannot overturn the approving vote");
});

test("requiredApprovals 2 keeps the v0.5.2 behaviour and text", async () => {
	const both = { reviewers: [reviewer("R1", "approve"), reviewer("R2", "approve")], planReview };
	const { value } = await run(both, submit);
	assert.match(value.additionalContexts[0].content[0].text, /^双模型审查已批准该计划（R1：通过；R2：通过）。/);
	const split = { reviewers: [reviewer("R1", "approve"), reviewer("R2", "revise")], planReview };
	await assert.rejects(run(split, submit), /要求修改计划（第 1\/2 轮）/);
});
