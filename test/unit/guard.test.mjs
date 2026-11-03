// Unit tests for the v0.6.0 risk gate: classification in the requirePlan
// guard, per-call destructive review with the requiredApprovals vote, and a
// subagent being judged by its owner session. The reviewers are stubbed by
// replacing globalThis.fetch with an OpenAI-compatible scripted endpoint.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply } from "../../lib/index.js";

const reviewer = (name, model) => ({ name, baseURL: "http://reviewer.unit/v1", apiKeyEnv: "DUAL_REVIEW_UNIT_KEY", model });

/** The scripted reviewer endpoint: the model id decides allow/deny/fail. */
function stubFetch() {
	const calls = [];
	const stub = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push(body.model);
		const kind = body.messages[0].content.split("\n", 1)[0];
		const text = body.model.includes("fail") ? null
			: kind === "DESTRUCTIVE_REVIEW_POLICY" || kind === "RISK_REVIEW_POLICY" ? JSON.stringify({ decision: body.model.includes("deny") ? "deny" : "allow", ...body.model.includes("deny") ? { reason: "测试拒绝" } : {} })
			: body.model.includes("revise") ? JSON.stringify({ verdict: "revise", blockers: ["缺少备份步骤"], additions: [] })
			: JSON.stringify({ verdict: "approve", blockers: [], additions: ["执行后验证结果"] });
		if (text === null) return { ok: false, status: 500, text: async () => "mock failure" };
		return {
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { role: "assistant", content: text } }] })
		};
	};
	return { stub, calls };
}

/**
 * Mount the plugin on a stub host, as presets.test.mjs does.
 * @param config plugin configuration (without reviewers)
 * @param options.planActive what the plan-mode service reports
 * @param options.agents live agents by Session id, for subagents' parents
 */
function mount(config, { planActive = true, agents = {} } = {}) {
	const hooks = new Map();
	const planMode = { get: (agent) => ({ active: typeof planActive === "function" ? planActive(agent) : planActive }), set: () => "committed" };
	const ctx = {
		permissionPresets: { registerAuto: () => () => {}, current: () => "workspace-write" },
		logger: { info() {}, warn() {} },
		get: (key) => ({ planMode, agents: { get: (id) => agents[id] } })[key],
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
	const preExecute = hooks.get("tools/pre-execute")[0];
	assert.equal(typeof preExecute, "function", "one tools/pre-execute hook");
	return preExecute;
}

const session = { header: {}, snapshotEvents: () => [], surface: { nodes: [] }, requestHeader: () => void 0 };
const topAgent = { session };
const childOf = (id) => ({ session: { header: { origin: "subagent", parentSession: id }, snapshotEvents: () => [], surface: { nodes: [] }, requestHeader: () => void 0 } });
const bash = (agent, command) => ({ name: "bash", agent, arguments: { command }, signal: new AbortController().signal });
const allow = async () => ({ kind: "allow" });

const riskGate = {
	enabled: true,
	mode: "requirePlan",
	rules: [
		{ tool: "^bash$", command: "\\bkubectl\\b[^|;&\\n]*\\sdelete\\b", class: "destructive" },
		{ tool: "^bash$", command: "\\bkubectl\\b[^|;&\\n]*\\s(scale|apply)\\b", class: "change" }
	]
};
const run = async (config, options, exec) => {
	const { stub, calls } = stubFetch();
	const previous = globalThis.fetch;
	const previousKey = process.env["DUAL_REVIEW_UNIT_KEY"];
	process.env["DUAL_REVIEW_UNIT_KEY"] = "test-key";
	globalThis.fetch = stub;
	try {
		return { result: await mount(config, options)(exec, allow), calls };
	} finally {
		globalThis.fetch = previous;
		if (previousKey === void 0) delete process.env["DUAL_REVIEW_UNIT_KEY"];
		else process.env["DUAL_REVIEW_UNIT_KEY"] = previousKey;
	}
};

test("in plan mode change and destructive are refused without any review call; read passes", async () => {
	const config = { reviewers: [reviewer("R1", "allow"), reviewer("R2", "allow")], requiredApprovals: 1, riskGate };
	for (const command of ["kubectl -n x scale deploy y --replicas=0", "kubectl -n x delete pod y"]) {
		const { result, calls } = await run(config, {}, bash(topAgent, command));
		assert.equal(result.kind, "deny", command);
		assert.equal(result.info.code, "PLAN_REQUIRED");
		assert.deepEqual(calls, [], "no review call");
	}
	const read = await run(config, {}, bash(topAgent, "kubectl get pods"));
	assert.deepEqual(read.result, { kind: "allow" });
	assert.deepEqual(read.calls, []);
});

test("with the plan approved a change passes with zero review calls, read always passes", async () => {
	const config = { reviewers: [reviewer("R1", "allow"), reviewer("R2", "deny")], riskGate };
	const change = await run(config, { planActive: false }, bash(topAgent, "kubectl -n x scale deploy y --replicas=2"));
	assert.deepEqual(change.result, { kind: "allow" });
	assert.deepEqual(change.calls, []);
	const read = await run(config, { planActive: true }, bash(topAgent, "kubectl get pods"));
	assert.deepEqual(read.result, { kind: "allow" });
	assert.deepEqual(read.calls, []);
});

test("destructive review with requiredApprovals 1: one allow out of two reviewers passes", async () => {
	const config = { reviewers: [reviewer("R1", "allow"), reviewer("R2", "deny")], requiredApprovals: 1, riskGate };
	const { result, calls } = await run(config, { planActive: false }, bash(topAgent, "kubectl -n x delete pod y"));
	assert.deepEqual(result, { kind: "allow" });
	assert.equal(calls.length, 2);
});

test("destructive review with requiredApprovals 1: two denies, or one allow plus one failure", async () => {
	const denying = { reviewers: [reviewer("R1", "deny"), reviewer("R2", "deny")], requiredApprovals: 1, riskGate };
	const denied = await run(denying, { planActive: false }, bash(topAgent, "kubectl -n x delete pod y"));
	assert.equal(denied.result.kind, "deny");
	assert.equal(denied.result.info.code, "RISK_GATE_DENIED");
	assert.match(denied.result.reason, /需要 1 票，得到 0 票/);
	assert.match(denied.result.reason, /R1：拒绝：测试拒绝；R2：拒绝：测试拒绝/);
	assert.equal(denied.calls.length, 2);
	const half = { reviewers: [reviewer("R1", "allow"), reviewer("R2", "fail")], requiredApprovals: 1, riskGate };
	const passed = await run(half, { planActive: false }, bash(topAgent, "kubectl -n x delete pod y"));
	assert.deepEqual(passed.result, { kind: "allow" }, "a failure counts as a disagreeing vote");
	assert.equal(passed.calls.length, 2);
});

test("destructive review with requiredApprovals 2: one allow out of two reviewers is denied", async () => {
	const config = { reviewers: [reviewer("R1", "allow"), reviewer("R2", "deny")], riskGate };
	const denied = await run(config, { planActive: false }, bash(topAgent, "kubectl -n x delete pod y"));
	assert.equal(denied.result.kind, "deny");
	assert.match(denied.result.reason, /需要 2 票，得到 1 票/);
	assert.match(denied.result.reason, /R2：拒绝：测试拒绝/);
	assert.equal(denied.calls.length, 2);
});

test("destructive without enough reviewers is refused without calling any", async () => {
	for (const reviewers of [[], [reviewer("R1", "allow")]]) {
		const config = { reviewers, riskGate };
		const denied = await run(config, { planActive: false }, bash(topAgent, "kubectl -n x delete pod y"));
		assert.equal(denied.result.kind, "deny");
		assert.equal(denied.result.info.code, "RISK_GATE_DENIED");
		assert.match(denied.result.reason, /没有足够可用的审查模型/);
		assert.deepEqual(denied.calls, []);
	}
});

test("a subagent's destructive call is judged and reviewed by its owner session", async () => {
	const parent = topAgent;
	const agents = { p: parent };
	const config = { reviewers: [reviewer("R1", "allow"), reviewer("R2", "allow")], requiredApprovals: 1, riskGate };
	const planning = await run(config, { planActive: (agent) => agent === parent, agents }, bash(childOf("p"), "kubectl -n x delete pod y"));
	assert.equal(planning.result.kind, "deny", "the parent is still planning");
	assert.equal(planning.result.info.code, "PLAN_REQUIRED");
	const approved = await run(config, { planActive: false, agents }, bash(childOf("p"), "kubectl -n x delete pod y"));
	assert.deepEqual(approved.result, { kind: "allow" });
	assert.equal(approved.calls.length, 2, "the destructive call is still reviewed after approval");
});
