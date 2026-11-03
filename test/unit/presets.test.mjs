// Unit tests for the per-preset behaviour (skipPresets, reportFallbackPresets)
// and the risk gate's requirePlan mode. DSH's one-shot headless runner does
// not compose agent presets, so the e2e suite cannot give a Session one; these
// drive the plugin's hooks against a stub host instead.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply } from "../../lib/index.js";

/** Two reviewers whose API key is never set, so every review fails at once. */
const failingReviewers = [
	{ name: "R1", baseURL: "http://127.0.0.1:9/v1", apiKeyEnv: "DUAL_REVIEW_UNIT_UNSET_KEY", model: "m" },
	{ name: "R2", baseURL: "http://127.0.0.1:9/v1", apiKeyEnv: "DUAL_REVIEW_UNIT_UNSET_KEY", model: "m" }
];

/**
 * Mount the plugin on a stub host.
 * @param config plugin configuration (reviewers default to two failing ones)
 * @param options.planActive what the plan-mode service reports: one value, or a function of the agent
 * @param options.projection whether the host has the `agentPreset` Session projection
 * @param options.agents live agents by Session id, for subagents' parents
 */
function mount(config, { planActive = true, projection = true, agents = {} } = {}) {
	const hooks = new Map();
	const planSets = [];
	const planMode = {
		get: (agent) => ({ active: typeof planActive === "function" ? planActive(agent) : planActive }),
		set: (_agent, active) => {
			planSets.push(active);
			return "committed";
		}
	};
	const sessionProjections = { stateOf: (session, key) => key === "agentPreset" ? session.projected ?? null : void 0 };
	const services = { planMode, agents: { get: (id) => agents[id] }, ...projection ? { sessionProjections } : {} };
	const ctx = {
		permissionPresets: { registerAuto: () => () => {}, current: () => "workspace-write" },
		logger: { info() {}, warn() {} },
		get: (key) => services[key],
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
	apply(ctx, { reviewers: failingReviewers, ...config });
	const hook = (event) => {
		const handlers = hooks.get(event) ?? [];
		assert.equal(handlers.length, 1, `one ${event} hook`);
		return handlers[0];
	};
	return { hook, hooks, planSets };
}

/** An Agent whose Session runs `preset`: through the projection, or only in its creation header. */
function agentOn(preset, { inHeader = false } = {}) {
	return {
		session: { header: inHeader ? { agentPreset: preset } : {}, projected: inHeader ? void 0 : preset },
		steer: async () => { throw new Error("unexpected steer"); }
	};
}

const planReview = { enabled: true, autoPlanMode: true, maxRevisions: 2, skipPresets: ["router"], reportFallbackPresets: ["worker"] };

test("a skipped preset is never put into plan mode; others are", () => {
	for (const projection of [true, false]) {
		const { hooks, planSets } = mount({ planReview }, { projection });
		const created = hooks.get("agent/created")[0];
		created({ agent: agentOn("router", { inHeader: !projection }) });
		assert.deepEqual(planSets, [], "router stays out of plan mode");
		created({ agent: agentOn("worker", { inHeader: !projection }) });
		assert.deepEqual(planSets, [true], "worker enters plan mode");
	}
});

test("the projection wins over the creation header", () => {
	const { hooks, planSets } = mount({ planReview });
	const agent = agentOn("worker");
	agent.session.header.agentPreset = "router";
	hooks.get("agent/created")[0]({ agent });
	assert.deepEqual(planSets, [true]);
});

test("a skipped preset's idle does not re-enter plan mode", () => {
	const { hook, planSets } = mount({ planReview, completionCheck: { enabled: true } });
	hook("agent/status")({ agent: agentOn("router"), status: "idle" });
	assert.deepEqual(planSets, []);
	hook("agent/status")({ agent: agentOn("worker"), status: "idle" });
	assert.deepEqual(planSets, [true]);
});

test("a skipped preset's exit_plan_mode goes straight to DSH", async () => {
	const { hook } = mount({ planReview });
	let nexts = 0;
	const result = await hook("tools/execute")({ name: "exit_plan_mode", agent: agentOn("router"), arguments: { plan: "# P\n" }, signal: new AbortController().signal }, async () => {
		nexts += 1;
		return { isError: false, value: { approved: true } };
	});
	assert.equal(nexts, 1);
	assert.deepEqual(result, { isError: false, value: { approved: true } });
});

test("a failed review on a report-fallback preset asks the agent to get consent instead of DSH's question", async () => {
	const { hook } = mount({ planReview });
	let nexts = 0;
	const next = async () => {
		nexts += 1;
		return { isError: false, value: { approved: false } };
	};
	await assert.rejects(hook("tools/execute")({ name: "exit_plan_mode", agent: agentOn("worker"), arguments: { plan: "# P\n" }, signal: new AbortController().signal }, next), (error) => {
		assert.match(error.message, /双模型计划审查没有通过（R1审查失败：.*；R2审查失败：.*），计划没有获批，仍处于计划模式，/);
		assert.match(error.message, /请把计划要做的操作和影响告诉请求人/);
		assert.match(error.message, /主动发起的任务（巡检、Argo CD 同步失败等）：不要等人/);
		return true;
	});
	assert.equal(nexts, 0, "DSH's plan-approval question is not opened");
	const result = await hook("tools/execute")({ name: "exit_plan_mode", agent: agentOn("standard"), arguments: { plan: "# P\n" }, signal: new AbortController().signal }, next);
	assert.equal(nexts, 1, "other presets fall back to DSH's question");
	assert.deepEqual(result, { isError: false, value: { approved: false } });
});

test("after a report fallback, the plan resubmitted in a later turn is approved on the requester's consent", async () => {
	const { hook, planSets } = mount({ planReview, completionCheck: { enabled: true } });
	const execute = hook("tools/execute"), status = hook("agent/status");
	const agent = agentOn("worker");
	const submit = () => execute({ name: "exit_plan_mode", agent, arguments: { plan: "# P\n\n请求人已同意。" }, signal: new AbortController().signal }, async () => {
		throw new Error("DSH's plan-approval question must not open");
	});
	await assert.rejects(submit(), /请把计划要做的操作和影响告诉请求人/);
	await assert.rejects(submit(), /请把计划要做的操作和影响告诉请求人/, "not in the turn that asked");
	status({ agent, status: "idle" });
	assert.deepEqual(planSets, [true]);
	const approved = await submit();
	assert.equal(approved.isError, false);
	assert.deepEqual(approved.value, { approved: true });
	assert.match(approved.additionalContexts[0].content[0].text, /按请求人的明确同意获批/);
	assert.deepEqual(planSets, [true, false], "plan mode is left");
	status({ agent, status: "idle" });
	await assert.rejects(submit(), /请把计划要做的操作和影响告诉请求人/, "consent covers one submission");
});

test("a skipped preset is never completion-checked", async () => {
	const { hook } = mount({ planReview, completionCheck: { enabled: true } });
	assert.equal(await hook("agent/turn-stopping")({ agent: agentOn("router"), signal: new AbortController().signal }), void 0);
});

const gate = { enabled: true, mode: "requirePlan", commands: ["\\bkubectl\\b[^|;&\\n]*\\sdelete\\b"], tools: ["^mcp__kubernetes__.*delete"] };
const bash = (agent, command) => ({ name: "bash", agent, arguments: { command }, signal: new AbortController().signal });

test("requirePlan refuses a risky call in plan mode without reviewers", async () => {
	for (const reviewers of [failingReviewers, []]) {
		const { hook } = mount({ reviewers, planReview, riskGate: gate });
		const preExecute = hook("tools/pre-execute");
		const allow = async () => ({ kind: "allow" });
		const denied = await preExecute(bash(agentOn("worker"), "kubectl -n x delete pod y"), allow);
		assert.equal(denied.kind, "deny");
		assert.equal(denied.info.code, "PLAN_REQUIRED");
		assert.match(denied.reason, /计划获批前不能执行/);
		const tool = await preExecute({ name: "mcp__kubernetes__resources_delete", agent: agentOn("worker"), arguments: {}, signal: new AbortController().signal }, allow);
		assert.equal(tool.kind, "deny");
		assert.deepEqual(await preExecute(bash(agentOn("worker"), "kubectl get pods"), allow), { kind: "allow" }, "reads pass");
		assert.deepEqual(await preExecute(bash(agentOn("router"), "kubectl -n x delete pod y"), allow), { kind: "allow" }, "skipped presets pass");
	}
});

test("requirePlan lets a risky call through once plan mode is off, without review", async () => {
	const { hook } = mount({ planReview, riskGate: gate }, { planActive: false });
	assert.deepEqual(await hook("tools/pre-execute")(bash(agentOn("worker"), "kubectl -n x delete pod y"), async () => ({ kind: "allow" })), { kind: "allow" });
});

test("requirePlan judges a subagent's call by its top-level ancestor's plan", async () => {
	const worker = agentOn("worker"), router = agentOn("router");
	const child = (parent) => ({ session: { header: { origin: "subagent", parentSession: parent }, projected: "standard" } });
	const grandchild = { session: { header: { origin: "subagent", parentSession: "c1" }, projected: "standard" } };
	const agents = { w: worker, r: router, c1: child("w") };
	const allow = async () => ({ kind: "allow" });
	const planning = mount({ planReview, riskGate: gate }, { agents, planActive: (agent) => agent === worker });
	const preExecute = planning.hook("tools/pre-execute");
	assert.equal((await preExecute(bash(child("w"), "kubectl -n x delete pod y"), allow)).kind, "deny", "worker still planning");
	assert.equal((await preExecute(bash(grandchild, "kubectl -n x delete pod y"), allow)).kind, "deny", "through two levels");
	assert.deepEqual(await preExecute(bash(child("r"), "kubectl -n x delete pod y"), allow), { kind: "allow" }, "router is skipped");
	assert.deepEqual(await preExecute(bash(child("gone"), "kubectl -n x delete pod y"), allow), { kind: "allow" }, "an unloaded parent leaves the subagent's own state");
	const approved = mount({ planReview, riskGate: gate }, { agents, planActive: false });
	assert.deepEqual(await approved.hook("tools/pre-execute")(bash(child("w"), "kubectl -n x delete pod y"), allow), { kind: "allow" }, "worker's plan approved");
});
