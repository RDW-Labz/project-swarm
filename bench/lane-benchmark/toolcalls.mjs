// SPDX-License-Identifier: Apache-2.0

const TOOLS = [
  {
    name: 'echo_text',
    description: 'Return the given text unchanged',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'add_numbers',
    description: 'Add two integers',
    parameters: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  {
    name: 'pick_color',
    description: 'Pick a color from a fixed enum',
    parameters: {
      type: 'object',
      properties: { color: { type: 'string', enum: ['red', 'green', 'blue'] } },
      required: ['color'],
      additionalProperties: false,
    },
  },
  {
    name: 'nested_box',
    description: 'Accept a nested object',
    parameters: {
      type: 'object',
      properties: {
        box: {
          type: 'object',
          properties: { label: { type: 'string' }, size: { type: 'integer' } },
          required: ['label', 'size'],
        },
      },
      required: ['box'],
      additionalProperties: false,
    },
  },
];

export const TOOLCALL_CHECKS = [
  {
    id: 'required-arg',
    tools: [TOOLS[0]],
    messages: [{ role: 'user', content: 'Call echo_text with text exactly "ping".' }],
    validate(response) {
      const call = oneTool(response, 'echo_text');
      return call?.function?.arguments && JSON.parse(call.function.arguments).text === 'ping';
    },
  },
  {
    id: 'choose-tool',
    tools: [TOOLS[0], TOOLS[1]],
    messages: [{ role: 'user', content: 'Add 2 and 3 using the math tool, not echo.' }],
    validate(response) {
      const call = oneTool(response, 'add_numbers');
      const args = call && JSON.parse(call.function.arguments);
      return args?.a === 2 && args?.b === 3;
    },
  },
  {
    id: 'parallel-tools',
    tools: [TOOLS[0], TOOLS[1]],
    messages: [{ role: 'user', content: 'In one response call echo_text with "a" AND add_numbers with a=1 b=2.' }],
    validate(response) {
      const calls = allTools(response);
      return calls.some(c => c.function?.name === 'echo_text') && calls.some(c => c.function?.name === 'add_numbers');
    },
  },
  {
    id: 'valid-json-args',
    tools: [TOOLS[1]],
    messages: [{ role: 'user', content: 'Add 4 and 5.' }],
    validate(response) {
      const call = oneTool(response, 'add_numbers');
      if (!call) return false;
      try {
        const args = JSON.parse(call.function.arguments);
        return typeof args.a === 'number' && typeof args.b === 'number';
      } catch { return false; }
    },
  },
  {
    id: 'tool-roundtrip',
    tools: [TOOLS[0]],
    messages: [
      { role: 'user', content: 'Call echo_text with text "round".' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'echo_text', arguments: '{"text":"round"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'round' },
      { role: 'user', content: 'What was echoed? Reply with one word only.' },
    ],
    validate(response) {
      const text = response.choices?.[0]?.message?.content ?? '';
      return /\bround\b/i.test(text) && !allTools(response).length;
    },
  },
  {
    id: 'no-tool-needed',
    tools: [TOOLS[0], TOOLS[1]],
    messages: [{ role: 'user', content: 'Reply with the word hello only. Do not call any tools.' }],
    validate(response) {
      return !allTools(response).length && /^hello\b/i.test((response.choices?.[0]?.message?.content ?? '').trim());
    },
  },
  {
    id: 'enum-arg',
    tools: [TOOLS[2]],
    messages: [{ role: 'user', content: 'Pick color green.' }],
    validate(response) {
      const call = oneTool(response, 'pick_color');
      return JSON.parse(call.function.arguments).color === 'green';
    },
  },
  {
    id: 'nested-object',
    tools: [TOOLS[3]],
    messages: [{ role: 'user', content: 'Call nested_box with box label "crate" and size 12.' }],
    validate(response) {
      const args = JSON.parse(oneTool(response, 'nested_box').function.arguments);
      return args.box?.label === 'crate' && args.box?.size === 12;
    },
  },
];

function oneTool(response, name) {
  return allTools(response).find(t => t.function?.name === name);
}

function allTools(response) {
  const msg = response.choices?.[0]?.message;
  if (!msg) return [];
  if (Array.isArray(msg.tool_calls)) return msg.tool_calls;
  if (msg.function_call) return [{ type: 'function', function: msg.function_call }];
  return [];
}

export async function runToolcallChecks({ baseUrl, model, apiKey, fetchImpl = globalThis.fetch, checks = TOOLCALL_CHECKS }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const lines = [];
  for (const check of checks) {
    const body = {
      model,
      temperature: 0,
      stream: false,
      messages: check.messages,
      tools: check.tools.map(t => ({ type: 'function', function: t })),
      tool_choice: 'auto',
    };
    let pass = false;
    let finishReason = null;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      finishReason = data.choices?.[0]?.finish_reason ?? null;
      pass = !!check.validate(data);
    } catch {
      pass = false;
    }
    lines.push({ id: check.id, pass, finishReason });
  }
  return lines;
}

export function formatToolcallReport(lines) {
  return lines.map(l => `${l.pass ? 'PASS' : 'FAIL'} ${l.id} finish_reason=${l.finishReason ?? 'n/a'}`).join('\n');
}
