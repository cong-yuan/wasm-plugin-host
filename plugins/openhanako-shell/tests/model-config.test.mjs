import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

const load = (rel, studio) => {
  const src = readFileSync(path.join(root, rel), 'utf8');
  return vm.runInNewContext(`(function(studio){ ${src} })`, { console })(studio);
};

let llmState = {
  providers: {
    mock: { model: 'mock-1' },
    deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-test', model: 'deepseek-chat' },
  },
  model_lists: { deepseek: ['deepseek-chat', 'deepseek-reasoner'] },
  current: { provider: 'deepseek', model: 'deepseek-chat' },
  default: 'deepseek',
  registered: ['mock', 'deepseek'],
};

const api = {
  DEFAULT_PROVIDER: 'mock',
  DEFAULT_MODEL: 'mock-1',
  mode: () => 'tauri',
  llmConfig: async () => structuredClone(llmState),
  setLlmConfig: async (patch) => {
    if (patch.providers) {
      for (const [k, v] of Object.entries(patch.providers)) {
        if (v == null) delete llmState.providers[k];
        else llmState.providers[k] = { ...(llmState.providers[k] || {}), ...v };
      }
    }
    if (patch.model_lists) llmState.model_lists = { ...llmState.model_lists, ...patch.model_lists };
    if (patch.current) llmState.current = patch.current;
    if (patch.default) llmState.default = patch.default;
    return structuredClone(llmState);
  },
  selection: async () => ({ ...llmState.current }),
  setSelection: async (provider, model) => {
    llmState.current = { provider, model };
    llmState.default = provider;
    return structuredClone(llmState);
  },
  create: async (provider, model) => `agent-${provider}-${model}`,
  sessions: async () => [],
  resume: async (id) => id,
  transcript: async () => [],
  sendWithProgress: async () => {},
  cancel: async () => {},
  steer: async () => {},
};

const studio = {
  require: (id) => {
    if (id === 'lib/api') return api;
    throw new Error('unexpected ' + id);
  },
};

const adapter = load('js/lib/hana-adapter.js', studio);
const models = await adapter.http('GET', '/api/models');
check('lists deepseek models', models.models.some((m) => m.id === 'deepseek-reasoner' && m.provider === 'deepseek'));
check('marks current model', models.models.some((m) => m.isCurrent && m.id === 'deepseek-chat'));

const switched = await adapter.http('POST', '/api/models/switch', { provider: 'mock', modelId: 'mock-1' });
check('switch updates selection', switched.ok && llmState.current.provider === 'mock');

const summary = await adapter.http('GET', '/api/providers/summary');
check('summary includes deepseek credentials', summary.providers.deepseek.has_credentials === true);

const cfg = await adapter.http('GET', '/api/config');
check('config providers expose deepseek', !!cfg.providers.deepseek);

await adapter.http('PUT', '/api/config', {
  providers: {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      model: 'gpt-4o',
      models: ['gpt-4o', 'gpt-4o-mini'],
    },
  },
});
check('put config stores provider', !!llmState.providers.openai && llmState.providers.openai.api_key === 'sk-x');
check('put config stores model list', Array.isArray(llmState.model_lists.openai) && llmState.model_lists.openai.includes('gpt-4o-mini'));

if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('model-config: ok');
