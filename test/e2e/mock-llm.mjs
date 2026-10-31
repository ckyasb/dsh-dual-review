// Scripted OpenAI-compatible endpoint for the end-to-end test.
// The agent model always asks to run one shell command that writes $MARKER;
// reviewer requests (system prompt starting with REVIEW_POLICY) are answered
// by model id: allow-model / allow2-model allow, deny-model denies, and
// fail-model returns HTTP 500. Every request is logged to $MOCK_LOG.
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
    const isReview = textOf(system).startsWith('REVIEW_POLICY');
    const tools = request.tools ?? [];
    const names = tools.map((t) => t.function?.name ?? t.name);
    log({ model, isReview });

    if (isReview) {
      if (model === 'fail-model') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"mock failure"}}');
        return;
      }
      reply(res, model, JSON.stringify(verdicts[model] ?? verdicts['allow-model']));
      return;
    }
    if (messages.at(-1)?.role === 'tool' || names.length === 0) {
      reply(res, model, 'done');
      return;
    }
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
  });
}).listen(port, '127.0.0.1');
