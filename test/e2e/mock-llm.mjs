// Scripted OpenAI-compatible endpoint for the end-to-end test.
// The agent model asks to run one shell command that writes $MARKER (or, in
// plan mode, calls exit_plan_mode). Reviewer requests are told apart by the
// first line of their system prompt and logged with a kind field:
// REVIEW_POLICY -> "call", PLAN_REVIEW_POLICY -> "plan",
// COMPLETION_POLICY -> "completion", RISK_REVIEW_POLICY -> "risk";
// everything else is "agent". Reviewer
// replies depend on the model id: allow-model / allow2-model allow,
// deny-model denies, revise-model asks for plan revisions, incomplete-model
// reports the task unfinished, and fail-/planfail-/donefail-model return
// HTTP 500. Every request is logged to $MOCK_LOG. Models whose id contains
// "eager" try the risky shell command before their first plan submission;
// once they see the guard's refusal in a tool result (logged as refused) they
// submit the plan instead.
import fs from 'node:fs';
import http from 'node:http';

const port = Number(process.env.MOCK_PORT ?? 18080);
const logFile = process.env.MOCK_LOG;
const marker = process.env.MARKER;
if (!logFile || !marker) throw new Error('MOCK_LOG and MARKER are required');

const log = (record) => fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`);
const verdicts = {
  'allow-model': { risk: 'low', decision: 'allow' },
  'allow2-model': { risk: 'medium', decision: 'allow' },
  'deny-model': { risk: 'high', decision: 'deny', reason: 'test deny' },
};
const planVerdicts = (model) => model.includes('planfail') ? null
  : model.includes('revise') ? { verdict: 'revise', blockers: ['测试阻断'], additions: [] }
  : { verdict: 'approve', blockers: [], additions: ['执行后确认 marker 文件存在'] };
const completionVerdicts = (model) => model.includes('donefail') ? null
  : model.includes('incomplete') ? { complete: false, missing: ['再次确认 marker 文件'] }
  : { complete: true };
const riskVerdicts = (model) => model.includes('riskfail') ? null
  : model.includes('riskdeny') ? { decision: 'deny', reason: '测试拒绝' }
  : { decision: 'allow' };
const fail500 = (res, model) => {
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end('{"error":{"message":"mock failure"}}');
};
const callOut = (messages) => {
  let calls = 0;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const call of m.tool_calls ?? []) if (call.function?.name === 'exit_plan_mode') calls += 1;
  }
  return calls;
};
const chunk = (model, delta, finish = null) => ({ id: 'mock', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = (model) => ({ id: 'mock', object: 'chat.completion.chunk', created: 0, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const textOf = (message) => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map((part) => part.text ?? '').join('');

function stream(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function reply(res, model, content) {
  stream(res, [chunk(model, { role: 'assistant', content }), chunk(model, {}, 'stop'), usage(model)]);
}

function replyOnce(res, model, content) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'mock', object: 'chat.completion', created: 0, model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }));
}

// Emit one streamed assistant turn that calls the session's shell tool with
// the marker-writing command.
function emitShellCall(res, model, tools) {
  const names = tools.map((t) => t.function?.name ?? t.name);
  const shell = ['bash', 'shell', 'exec'].find((n) => names.includes(n)) ?? names.find((n) => /bash|shell|exec/i.test(n));
  if (!shell) {
    log({ noShellTool: names });
    reply(res, model, 'no shell tool');
    return;
  }
  const params = tools.find((t) => (t.function?.name ?? t.name) === shell).function?.parameters ?? {};
  const args = {};
  for (const key of params.required ?? []) {
    const type = params.properties?.[key]?.type;
    args[key] = type === 'number' || type === 'integer' ? 30000 : 'x';
  }
  for (const key of ['command', 'cmd', 'script']) {
    if (key in (params.properties ?? {})) args[key] = `echo dual-review-ran > ${marker}`;
  }
  stream(res, [
    chunk(model, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: shell, arguments: JSON.stringify(args) } }] }),
    chunk(model, {}, 'tool_calls'),
    usage(model),
  ]);
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (data) => { body += data; });
  req.on('end', () => {
    if (!req.url.includes('chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
      return;
    }
    const request = JSON.parse(body);
    const { model } = request;
    const messages = request.messages ?? [];
    const system = messages.find((m) => m.role === 'system' || m.role === 'developer');
    const systemText = textOf(system);
    const firstLine = systemText.split('\n', 1)[0] ?? '';
    const kind = firstLine === 'REVIEW_POLICY' ? 'call'
      : firstLine === 'PLAN_REVIEW_POLICY' ? 'plan'
      : firstLine === 'COMPLETION_POLICY' ? 'completion'
      : firstLine === 'RISK_REVIEW_POLICY' ? 'risk'
      : 'agent';
    const isReview = kind !== 'agent';
    const tools = request.tools ?? [];
    const names = tools.map((t) => t.function?.name ?? t.name);
    // For plan reviews and completion checks, record how many entries the
    // CURRENT_TURN section carried, so the test can catch an empty transcript.
    const sections = textOf(messages.find((m) => m.role === 'user')).split('\n\n');
    const turnAt = sections.indexOf('CURRENT_TURN');
    const currentTurn = turnAt < 0 ? undefined : JSON.parse(sections[turnAt + 1]).length;
    log({ model, isReview, kind, ...(kind === 'plan' || kind === 'completion' ? { currentTurn } : {}) });

    if (isReview) {
      const content = kind === 'risk' ? riskVerdicts(model)
        : kind === 'plan' ? planVerdicts(model)
        : kind === 'completion' ? completionVerdicts(model)
        : model === 'fail-model' ? null
        : verdicts[model] ?? verdicts['allow-model'];
      if (content === null) {
        fail500(res, model);
        return;
      }
      const text = JSON.stringify(content);
      if (request.stream === true) reply(res, model, text);
      else replyOnce(res, model, text);
      return;
    }
    if (systemText.includes('PLAN_MODE_ACTIVE') && names.includes('exit_plan_mode')) {
      const refused = messages.some((m) => m.role === 'tool' && textOf(m).includes('计划获批前不能执行'));
      if (refused) log({ refused: 1 });
      // An "eager" model tries the risky shell command before its first plan
      // submission; the guard must refuse it, and only then does it plan.
      if (model.includes('eager') && !refused && callOut(messages) === 0) {
        emitShellCall(res, model, tools);
        return;
      }
      if (callOut(messages) >= 3) {
        reply(res, model, 'gave up');
        return;
      }
      stream(res, [
        chunk(model, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# Test plan\n\n1. Write the marker file.' }) } }] }),
        chunk(model, {}, 'tool_calls'),
        usage(model),
      ]);
      return;
    }
    const last = messages.at(-1);
    if (last?.role === 'user' && textOf(last).includes('双模型完成度检查')) {
      log({ steered: true });
      reply(res, model, 'done again');
      return;
    }
    if (last?.role === 'tool' || names.length === 0) {
      reply(res, model, 'done');
      return;
    }
    emitShellCall(res, model, tools);
  });
}).listen(port, '127.0.0.1');
