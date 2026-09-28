import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const failures = [];
const check = (label, cond) => {
  if (!cond) failures.push(label);
};

const rawCalls = [];
global.window = {
  __TAURI_INTERNALS__: {
    invoke(cmd, args) {
      rawCalls.push({ cmd, args });
      return Promise.resolve({ raw: true, cmd, args });
    },
  },
  __TAURI__: null,
};

const openSource = readFileSync(join(ROOT, 'js/lib/tauri-invoke.js'), 'utf8');
const secureActions = [];
const secureEvents = [];
const studioSecure = {
  hostAction(action) {
    secureActions.push(action);
    return Promise.resolve({ secure: true, action });
  },
  listenHostEvent(event, handler) {
    secureEvents.push(event);
    handler({ payload: { hello: 'world' } });
    return Promise.resolve(() => {});
  },
};

const secure = new Function('studio', openSource)(studioSecure);
check('secure mode reports bridge', secure.mode() === 'bridge');
check('secure mode is available', secure.available() === true);

const answer = await secure.invoke('list_sessions', { limit: 20 });
check('hostAction result is returned', answer && answer.secure === true);
check('typed backend action emitted',
  secureActions.length === 1
  && secureActions[0].kind === 'backend_command'
  && secureActions[0].command === 'list_sessions'
  && secureActions[0].args.limit === 20);
check('plugin identity is not self-reported',
  !Object.prototype.hasOwnProperty.call(secureActions[0], 'plugin_id')
  && !Object.prototype.hasOwnProperty.call(secureActions[0], 'slot'));
check('raw Tauri invoke bypassed in secure mode', rawCalls.length === 0);

let eventPayload = null;
const unlisten = await secure.listen('studio://chat-partial', (payload) => {
  eventPayload = payload;
});
check('controlled host event listener preferred',
  secureEvents.length === 1 && secureEvents[0] === 'studio://chat-partial');
check('host event payload normalized', eventPayload && eventPayload.hello === 'world');
check('controlled listener returns unlisten', typeof unlisten === 'function');
check('still no raw Tauri in secure mode', rawCalls.length === 0);

const studioSecureNoEvents = {
  hostAction: studioSecure.hostAction,
};
const secureNoEvents = new Function('studio', openSource)(studioSecureNoEvents);
const absent = await secureNoEvents.listen('studio://chat-partial', () => {});
check('secure host without event bridge fails closed to polling path', absent === null);
check('secure host without event bridge does not touch raw Tauri', rawCalls.length === 0);

const legacy = new Function('studio', openSource)({});
check('legacy mode reports tauri', legacy.mode() === 'tauri');
const legacyAnswer = await legacy.invoke('list_sessions', { limit: 1 });
check('legacy trusted mode keeps raw Tauri compatibility',
  legacyAnswer && legacyAnswer.raw === true
  && rawCalls.some((c) => c.cmd === 'list_sessions' && c.args.limit === 1));

const hanaSource = readFileSync(join(ROOT, '../hana-shell/js/lib/api.js'), 'utf8');
const hanaActions = [];
const hanaStudio = {
  hostAction(action) {
    hanaActions.push(action);
    return Promise.resolve({ ok: true, action });
  },
};
const hana = new Function('studio', hanaSource)(hanaStudio);
rawCalls.length = 0;
check('hana bridge is available', hana.available() === true);
const hanaStatus = await hana.raw('studio_status', { detail: true });
check('hana uses typed backend command through secure bridge',
  hanaStatus && hanaStatus.ok === true
  && hanaActions.length === 1
  && hanaActions[0].kind === 'backend_command'
  && hanaActions[0].command === 'studio_status'
  && hanaActions[0].args.detail === true);
check('hana secure path bypasses raw Tauri', rawCalls.length === 0);

if (failures.length) {
  console.error('secure plugin bridge failures:');
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}
console.log('secure plugin bridge: ok');
