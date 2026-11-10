const prompt = process.argv.slice(2).join(' ');
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (prompt.includes('WAIT-CANCEL')) {
  setInterval(() => {}, 1000);
} else {
  send({ type: 'assistant', text: `thinking about ${prompt}` });
  send({ type: 'tool_call', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } });
  send({ type: 'result', result: `finished ${prompt}`, usage: { input_tokens: 3, output_tokens: 2 } });
  process.exit(0);
}
