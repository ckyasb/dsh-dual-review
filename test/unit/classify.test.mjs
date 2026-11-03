// Unit tests for classifyCall: rule order, command and args conditions, the
// legacy commands/tools fallback, the default read class, and invalid rules
// being skipped. Pure functions, so no host stub is needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCall, compileRiskGate } from "../../lib/index.js";

const compile = (riskGate) => compileRiskGate({}, { riskGate });

test("the first matching rule wins", () => {
	const compiled = compile({ rules: [
		{ tool: "^bash$", command: "\\bkubectl\\b", class: "change" },
		{ tool: "^bash$", class: "destructive" }
	] });
	assert.equal(classifyCall("bash", { command: "kubectl delete pod x" }, compiled), "change");
	const destructiveFirst = compile({ rules: [
		{ tool: "^bash$", class: "destructive" },
		{ tool: "^bash$", command: "\\bkubectl\\b", class: "change" }
	] });
	assert.equal(classifyCall("bash", { command: "kubectl delete pod x" }, destructiveFirst), "destructive");
});

test("command and args conditions must both hit", () => {
	const compiled = compile({ rules: [
		{ tool: "^bash$", command: "\\bdelete\\b", args: '"force":true', class: "destructive" },
		{ tool: "^bash$", command: "\\bdelete\\b", class: "change" }
	] });
	assert.equal(classifyCall("bash", { command: "helm delete x" }, compiled), "change", "command hits, args does not");
	assert.equal(classifyCall("bash", { command: "kubectl delete pod x", force: true }, compiled), "destructive", "the args condition tests the whole arguments JSON");
	const argsOnly = compile({ rules: [{ tool: "^mcp__app$", args: '"replicas":0\\b', class: "destructive" }] });
	assert.equal(classifyCall("mcp__app", { replicas: 0 }, argsOnly), "destructive");
	assert.equal(classifyCall("mcp__app", { replicas: 1 }, argsOnly), "read");
});

test("a command rule does not hit when arguments.command is not a string", () => {
	const compiled = compile({ rules: [{ tool: "^bash$", command: ".", class: "destructive" }] });
	assert.equal(classifyCall("bash", {}, compiled), "read");
	assert.equal(classifyCall("bash", { command: 5 }, compiled), "read");
});

test("the legacy commands and tools patterns fall back to change", () => {
	const compiled = compile({ commands: ["\\bkubectl\\b[^|;&\\n]*\\sdelete\\b"], tools: ["^mcp__kubernetes__.*delete"] });
	assert.equal(classifyCall("bash", { command: "kubectl -n x delete pod y" }, compiled), "change");
	assert.equal(classifyCall("bash", { command: "kubectl get pods" }, compiled), "read");
	assert.equal(classifyCall("mcp__kubernetes__resources_delete", {}, compiled), "change");
	assert.equal(classifyCall("mcp__kubernetes__resources_get", {}, compiled), "read");
});

test("everything unmatched is read", () => {
	assert.equal(classifyCall("read", {}, compile({})), "read");
	assert.equal(classifyCall("bash", { command: "ls" }, compile({ commands: ["\\bdelete\\b"], rules: [{ tool: "^mcp__", class: "destructive" }] })), "read");
});

test("invalid rules are skipped with a warning and do not stop loading", () => {
	const warnings = [];
	const ctx = { logger: { warn: (line) => warnings.push(line), info() {} } };
	const compiled = compileRiskGate(ctx, { riskGate: { rules: [
		"not an object",
		{ command: "\\bdelete\\b", class: "destructive" },
		{ tool: "^bash$", class: "catastrophic" },
		{ tool: "^bash$", command: "(", class: "destructive" },
		{ tool: "^bash$", args: "[", class: "destructive" },
		{ tool: "^bash$", command: "\\bdelete\\b", class: "destructive" }
	] } });
	assert.equal(classifyCall("bash", { command: "kubectl delete pod x" }, compiled), "destructive", "the valid rule still works");
	assert.equal(warnings.length, 5);
	assert.equal(classifyCall("bash", { command: "kubectl delete pod x" }, compile({ rules: ["nope"] })), "read");
});
