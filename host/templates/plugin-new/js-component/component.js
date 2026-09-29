import { log } from 'wasm-plugin-host:plugin/host-log@0.3.0';
import { getConfig, configVersion } from 'wasm-plugin-host:plugin/host-config@0.3.0';

export const lifecycle = {
  abiVersion() {
    return 1;
  },

  init() {
    log('info', '__PLUGIN_NAME__ initialized through host-log');
    return { tag: 'ok', val: undefined };
  },

  configure(_configJson) {
    return { tag: 'ok', val: undefined };
  },

  describe() {
    return {
      name: '__PLUGIN_NAME__',
      abi: 1,
      tools: [{
        name: '__CRATE_STEM___echo',
        description: 'Echo JSON through a JavaScript WebAssembly Component',
        parametersJson: '{"type":"object"}',
        exec: 'echo',
        requires: []
      }],
      hooks: [],
      injects: [],
      provides: [],
      capabilities: {
        filesystem: { read: [], write: [], create: [], delete: [] },
        network: { allow: ['api.example.com'], methods: ['GET'] },
        agent: { observe: [], rewrite: [], veto: [] },
        services: { consume: [], provide: [] },
        ui: {
          slots: [],
          routes: [],
          windows: false,
          theme: false,
          adjusts: [],
          backendCommands: [],
          hostEvents: []
        }
      },
      ui: undefined
    };
  },

  invoke(op, argsJson) {
    if (op === 'echo') {
      const config = JSON.parse(getConfig());
      const version = configVersion();
      log('info', `__PLUGIN_NAME__ echo configVersion=${version}`);
      return {
        tag: 'success',
        val: {
          content: `js component echo source=${config.source ?? 'unknown'}`,
          valueJson: argsJson
        }
      };
    }
    return {
      tag: 'error',
      val: {
        code: 'unknown_op',
        message: `unknown op: ${op}`,
        valueJson: 'null'
      }
    };
  },

  shutdown() {}
};
