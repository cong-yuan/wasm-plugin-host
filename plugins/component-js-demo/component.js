export const lifecycle = {
  abiVersion() {
    return 1;
  },

  init() {
    return { tag: 'ok', val: undefined };
  },

  configure(_configJson) {
    return { tag: 'ok', val: undefined };
  },

  describe() {
    return {
      name: 'component-js-demo',
      abi: 1,
      tools: [{
        name: 'js_component_echo',
        description: 'Echo JSON through a JavaScript WebAssembly Component',
        parametersJson: '{"type":"object"}',
        exec: 'echo'
      }],
      hooks: [],
      injects: [],
      provides: [],
      capabilities: {
        filesystem: { read: [], write: [], create: [], delete: [] },
        network: { allow: [], methods: [] },
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
      uiJson: undefined
    };
  },

  invoke(op, argsJson) {
    if (op === 'echo') {
      return {
        tag: 'success',
        val: {
          content: 'js component echo',
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
