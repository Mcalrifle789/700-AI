// Custom AI agents. Users define an agent (name + system prompt + optional
// model override); it becomes callable in chat via `@name ...` or `/agent run`.
import prompts from 'prompts';
import { c, brand } from './theme.js';
import { agents } from './store.js';

export async function manageAgents() {
  console.log('\n' + brand('  700 AI — Custom Agents') + '\n');
  const existing = agents.list();
  if (existing.length) {
    console.log(c.dim('  Your agents:'));
    for (const a of existing) console.log('    ' + c.orange('@' + a.name) + c.dim('  ' + (a.role || '')));
    console.log('');
  }

  const { action } = await prompts({
    type: 'select', name: 'action', message: 'Agents',
    choices: [
      { title: 'Create a new agent', value: 'create' },
      { title: 'Close', value: 'close' },
    ],
  }, { onCancel: () => ({ action: 'close' }) });
  if (action !== 'create') return;

  const a = await prompts([
    { type: 'text', name: 'name', message: 'Agent handle (one word):' },
    { type: 'text', name: 'role', message: 'Short role/description:' },
    { type: 'text', name: 'system', message: 'System prompt (its instructions):' },
    { type: 'text', name: 'model', message: 'Model override (blank = default):' },
  ], { onCancel: () => ({}) });

  if (!a.name || !a.system) { console.log(c.dim('  Cancelled.\n')); return; }
  agents.save({ name: a.name.replace(/\W/g, ''), role: a.role, system: a.system, model: a.model || null });
  console.log('\n' + c.green(`  ✓ Agent @${a.name} created.`) + c.dim('  Use it in chat: ') + c.white(`@${a.name} <message>`) + '\n');
}

export function findAgent(text) {
  const m = text.match(/^@(\w+)\s+([\s\S]+)/);
  if (!m) return null;
  const agent = agents.list().find((a) => a.name === m[1]);
  return agent ? { agent, message: m[2] } : null;
}
