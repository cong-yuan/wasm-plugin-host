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
  rebind: async (agentId, provider, model) => {
    if (provider) llmState.current = { provider, model };
    return agentId;
  },
  dispose: async (agentId) => agentId,
  softUnbind: async (agentId) => agentId,
  listModels: async () => Object.entries(llmState.model_lists).flatMap(([provider, list]) =>
    (list || []).map((id) => ({ id, name: id, provider }))),
  getLlmConfig: async () => structuredClone(llmState),
  fetchLlmModels: async (opts) => (llmState.model_lists[opts?.provider] || []).map((id) => ({ id, name: id, provider: opts?.provider })),
  syncLlmAdapters: async () => structuredClone(llmState),
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
check('no phantom provider-named model', !models.models.some((m) => m.id === m.provider && m.provider !== 'mock'));

// Per-session switch: the upstream ModelSelector posts sessionPath, and the
// adapter rebinds that session's live agent to the chosen provider/model.
const switched = await adapter.http('POST', '/api/models/switch', { sessionPath: 'studio://sess-1', provider: 'mock', modelId: 'mock-1' });
check('switch updates selection', switched.ok && llmState.current.provider === 'mock');

const summary = await adapter.http('GET', '/api/providers/summary');
check('summary includes deepseek credentials', summary.providers.deepseek.has_credentials === true);

const cfg = await adapter.http('GET', '/api/config');
check('config providers expose deepseek', !!cfg.providers.deepseek);

await adapter.http('PUT', '/api/config', {
  providers: {
    openai: {
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-x',
      model: 'gpt-4o',
      models: ['gpt-4o', 'gpt-4o-mini'],
    },
  },
});
check('put config stores provider', !!llmState.providers.openai && llmState.providers.openai.api_key === 'sk-x');
check('put config stores model list', Array.isArray(llmState.model_lists.openai) && llmState.model_lists.openai.includes('gpt-4o-mini'));

// Empty provider must not invent a model named after itself.
llmState.providers.blank = { base_url: 'http://127.0.0.1:9', api_key: 'x' };
llmState.model_lists.blank = [];
const blank = await adapter.http('GET', '/api/models');
check('blank provider has no auto model', !blank.models.some((m) => m.provider === 'blank'));

if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('model-config: ok');
