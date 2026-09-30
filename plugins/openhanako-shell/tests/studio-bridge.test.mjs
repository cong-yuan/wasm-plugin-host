// Parent-side vertical slice: Tauri commands when invoke exists, mock
// fallback when it does not, iframe postMessage contract, and incremental
// streaming deltas (best-effort via transcript poll / mock chunks).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const messageHandlers = [];
global.window = {
  __TAURI_INTERNALS__: null,
  __TAURI__: null,
  addEventListener(type, fn) {
    if (type === 'message') messageHandlers.push(fn);
  },
  removeEventListener(type, fn) {
    if (type !== 'message') return;
    const i = messageHandlers.indexOf(fn);
    if (i >= 0) messageHandlers.splice(i, 1);
  },
};

const sources = new Map();
for (const name of [
  'lib/tauri-invoke.js',
  'lib/api.js',
  'lib/session-search.js',
  'lib/hana-adapter.js',
  'lib/host-bridge.js',
]) {
  sources.set(name.replace(/\.js$/, ''), readFileSync(join(ROOT, 'js', name), 'utf8'));
}
const cache = new Map();
const studio = {
  require(name) {
    const key = name.replace(/\.js$/, '');
    if (cache.has(key)) return cache.get(key);
    const src = sources.get(key);
    if (!src) throw new Error('module not found: ' + name);
    const value = new Function('studio', src)(studio);
    cache.set(key, value);
    return value;
  },
};

const failures = [];
const check = (label, cond) => { if (!cond) failures.push(label); };

const tauri = studio.require('lib/tauri-invoke');
const api = studio.require('lib/api');
const adapter = studio.require('lib/hana-adapter');
const host = studio.require('lib/host-bridge');

let invokeError = null;
try { await tauri.invoke('list_sessions'); } catch (err) { invokeError = err; }
check('invoke rejects with a clear error when Tauri is missing',
  invokeError && /Tauri invoke is not available/.test(invokeError.message));
check('api mode is mock without invoke', api.mode() === 'mock');

const health = await adapter.http('GET', '/api/health');
check('mock health is labeled', health.studioBridge === 'mock' && health.status === 'ok');
const listed = await adapter.http('GET', '/api/sessions');
check('mock sessions use studio:// paths',
  listed.length === 2 && listed[0].path === 'studio://sess-welcome' && listed[0].sessionId === 'sess-welcome');
check('mock sessions keep a stable assistant id', listed.every((s) => s.agentId === 'studio'));

const archivedSessions = await adapter.http('GET', '/api/sessions/archived');
check('archived sessions endpoint returns array', Array.isArray(archivedSessions));
const missingRename = await adapter.http('POST', '/api/sessions/rename', { sessionId: 'x', title: 'y' });
check('rename rejects missing sessions',
  missingRename && missingRename.ok === false && missingRename.error === 'session not found');
const initialProfile = await adapter.http('GET', '/api/user-profile');
check('user-profile defaults to an empty local profile',
  initialProfile?.name === 'User' && initialProfile?.content === '' && initialProfile?.avatar === null);

{
  const renamedConfig = await adapter.http('PUT', '/api/config', {
    user: { name: '  Studio   User  ' },
  });
  check('global config persists normalized user name',
    renamedConfig?.ok === true && renamedConfig?.user?.name === 'Studio User');
  const savedProfile = await adapter.http('PUT', '/api/user-profile', {
    content: 'Local Studio profile',
  });
  check('user-profile write persists content',
    savedProfile?.ok === true && savedProfile?.content === 'Local Studio profile');

  const [config, profile, agentConfig, renamedHealth, identity] = await Promise.all([
    adapter.http('GET', '/api/config'),
    adapter.http('GET', '/api/user-profile'),
    adapter.http('GET', '/api/agents/studio/config'),
    adapter.http('GET', '/api/health'),
    adapter.http('GET', '/api/server/identity'),
  ]);
  check('user name is shared across config, agent config, health, and server identity',
    config?.user?.name === 'Studio User'
    && agentConfig?.user?.name === 'Studio User'
    && renamedHealth?.user === 'Studio User'
    && identity?.userLabel === 'Studio User');
  check('user-profile reads the persisted profile and shared name',
    profile?.content === 'Local Studio profile' && profile?.name === 'Studio User');

  const rejectedName = await adapter.http('PUT', '/api/config', { user: { name: '   ' } });
  check('blank user name is rejected', rejectedName?.ok === false && rejectedName?.error === 'user name required');
  const rejectedProfile = await adapter.http('PUT', '/api/user-profile', {});
  check('profile writes require string content',
    rejectedProfile?.ok === false && rejectedProfile?.error === 'profile content required');

  await adapter.http('PUT', '/api/config', { user: { name: 'User' } });
  await adapter.http('PUT', '/api/user-profile', { content: '' });
}

// Studio has no scheduler backend, but automation drafts should still be real,
// editable local data instead of an always-empty GET stub.
{
  const initial = await adapter.http('GET', '/api/desk/cron');
  check('automation drafts start empty and advertise scheduler capability honestly',
    Array.isArray(initial?.jobs)
    && initial.jobs.length === 0
    && initial.schedulerAvailable === false
    && initial.editableDrafts === true);

  const added = await adapter.http('POST', '/api/desk/cron', {
    action: 'add',
    type: 'cron',
    schedule: '0 9 * * *',
    label: 'Morning draft',
    prompt: 'Summarize the morning',
    enabled: false,
    actorAgentId: 'studio',
  });
  check('automation draft add persists a disabled job',
    added?.ok === true && added?.job?.id && added.job.enabled === false);
  const jobId = added?.job?.id;

  const enabled = await adapter.http('POST', '/api/desk/cron', {
    action: 'update',
    id: jobId,
    enabled: true,
  });
  check('automation enable fails closed when scheduler is unavailable',
    enabled?.ok === false && enabled?.code === 'scheduler_unavailable');

  const updated = await adapter.http('POST', '/api/desk/cron', {
    action: 'update',
    id: jobId,
    label: 'Updated draft',
    prompt: 'Updated prompt',
  });
  const afterUpdate = await adapter.http('GET', '/api/desk/cron');
  check('automation draft update persists editable fields',
    updated?.ok === true
    && afterUpdate.jobs.some((job) => job.id === jobId
      && job.label === 'Updated draft'
      && job.prompt === 'Updated prompt'
      && job.enabled === false));

  const suggestion = await adapter.http('POST', '/api/desk/cron', {
    action: 'apply_suggestion',
    suggestionId: 's-1',
    sessionId: listed[0].sessionId,
    jobData: {
      type: 'every',
      schedule: 60,
      label: 'Suggestion draft',
      prompt: 'Draft only',
    },
  });
  check('automation suggestion apply fails closed without a scheduler',
    suggestion?.ok === false && suggestion?.code === 'scheduler_unavailable');

  const removed = await adapter.http('POST', '/api/desk/cron', { action: 'remove', id: jobId });
  check('automation draft remove deletes the selected job', removed?.ok === true);
  const cleanupJobs = (await adapter.http('GET', '/api/desk/cron')).jobs || [];
  for (const job of cleanupJobs) {
    await adapter.http('POST', '/api/desk/cron', { action: 'remove', id: job.id });
  }
  check('automation draft cleanup returns to empty list',
    (await adapter.http('GET', '/api/desk/cron')).jobs.length === 0);
}

const initialAppearance = await adapter.http('GET', '/api/preferences/appearance');
check('appearance preferences expose stable defaults',
  initialAppearance?.appearance?.theme === 'warm-paper'
  && initialAppearance?.appearance?.serif === true
  && initialAppearance?.appearance?.paperTexture === false
  && initialAppearance?.appearance?.leavesOverlay === false);
const savedAppearance = await adapter.http('PUT', '/api/preferences/appearance', {
  theme: 'midnight',
  serif: false,
  paperTexture: true,
  leavesOverlay: true,
});
check('appearance preferences persist a validated patch',
  savedAppearance?.ok === true
  && savedAppearance?.appearance?.theme === 'midnight'
  && savedAppearance?.appearance?.serif === false
  && savedAppearance?.appearance?.paperTexture === true
  && savedAppearance?.appearance?.leavesOverlay === true);
const partialAppearance = await adapter.http('PATCH', '/api/preferences/appearance', {
  appearance: { theme: 'claude-design', paperTexture: false },
});
check('appearance preferences merge partial patches and migrate legacy theme ids',
  partialAppearance?.ok === true
  && partialAppearance?.appearance?.theme === 'new-warm-paper'
  && partialAppearance?.appearance?.serif === false
  && partialAppearance?.appearance?.paperTexture === false
  && partialAppearance?.appearance?.leavesOverlay === true);
const rejectedAppearanceTheme = await adapter.http('PUT', '/api/preferences/appearance', { theme: 'not-a-theme' });
check('appearance preferences reject unknown themes',
  rejectedAppearanceTheme?.ok === false && rejectedAppearanceTheme?.error === 'invalid appearance theme');
const rejectedAppearanceBoolean = await adapter.http('PUT', '/api/preferences/appearance', { serif: 'yes' });
check('appearance preferences reject non-boolean flags',
  rejectedAppearanceBoolean?.ok === false && rejectedAppearanceBoolean?.error === 'invalid appearance serif');
await adapter.http('PUT', '/api/preferences/appearance', {
  theme: 'warm-paper',
  serif: true,
  paperTexture: false,
  leavesOverlay: false,
});

const initialSidebarUi = await adapter.http('GET', '/api/preferences/sidebar-ui');
check('sidebar UI preferences expose stable defaults',
  initialSidebarUi?.sidebarUi?.sessionList?.rowMode === 'two-line'
  && initialSidebarUi?.sidebarUi?.projectView?.collapsedProjectIds?.length === 0
  && initialSidebarUi?.sidebarUi?.projectView?.collapsedFolderIds?.length === 0
  && initialSidebarUi?.sidebarUi?.projectView?.showAllProjectIds?.length === 0);
const savedSidebarUi = await adapter.http('PUT', '/api/preferences/sidebar-ui', {
  sessionList: { rowMode: 'single-line' },
  projectView: {
    collapsedProjectIds: ['project-a', ' project-a ', '', 'project-b'],
    collapsedFolderIds: ['folder-a'],
  },
});
check('sidebar UI preferences persist normalized row and project state',
  savedSidebarUi?.ok === true
  && savedSidebarUi?.sidebarUi?.sessionList?.rowMode === 'single-line'
  && savedSidebarUi?.sidebarUi?.projectView?.collapsedProjectIds?.join(',') === 'project-a,project-b'
  && savedSidebarUi?.sidebarUi?.projectView?.collapsedFolderIds?.join(',') === 'folder-a');
const partialSidebarUi = await adapter.http('PATCH', '/api/preferences/sidebar-ui', {
  sidebarUi: { projectView: { showAllProjectIds: ['project-a'] } },
});
check('sidebar UI preferences merge partial patches',
  partialSidebarUi?.ok === true
  && partialSidebarUi?.sidebarUi?.sessionList?.rowMode === 'single-line'
  && partialSidebarUi?.sidebarUi?.projectView?.collapsedProjectIds?.join(',') === 'project-a,project-b'
  && partialSidebarUi?.sidebarUi?.projectView?.showAllProjectIds?.join(',') === 'project-a');
const ignoredSidebarMode = await adapter.http('PUT', '/api/preferences/sidebar-ui', {
  sessionList: { rowMode: 'invalid' },
});
check('sidebar UI preferences ignore invalid row modes like upstream normalization',
  ignoredSidebarMode?.ok === true && ignoredSidebarMode?.sidebarUi?.sessionList?.rowMode === 'single-line');
const rejectedSidebarBody = await adapter.http('PUT', '/api/preferences/sidebar-ui', null);
check('sidebar UI preferences reject non-object writes',
  rejectedSidebarBody?.ok === false && rejectedSidebarBody?.error === 'sidebar UI object required');
await adapter.http('PUT', '/api/preferences/sidebar-ui', {
  sessionList: { rowMode: 'two-line' },
  projectView: {
    collapsedProjectIds: [],
    collapsedFolderIds: [],
    showAllProjectIds: [],
  },
});

const initialQuickChat = await adapter.http('GET', '/api/preferences/quick-chat');
check('quick chat preferences expose upstream-compatible defaults',
  initialQuickChat?.quickChat?.shortcut === 'Alt+Space'
  && initialQuickChat?.quickChat?.reuseTimeoutMinutes === 10);
const savedQuickChat = await adapter.http('PUT', '/api/preferences/quick-chat', {
  quickChat: {
    shortcut: 'CmdOrCtrl+Spacebar',
    reuseTimeoutMinutes: 999,
  },
});
check('quick chat preferences normalize shortcut aliases and clamp reuse timeout',
  savedQuickChat?.ok === true
  && savedQuickChat?.quickChat?.shortcut === 'CommandOrControl+Space'
  && savedQuickChat?.quickChat?.reuseTimeoutMinutes === 120);
const partialQuickChat = await adapter.http('PATCH', '/api/preferences/quick-chat', {
  reuse_timeout_minutes: -5,
});
check('quick chat preferences merge snake-case partial patches',
  partialQuickChat?.ok === true
  && partialQuickChat?.quickChat?.shortcut === 'CommandOrControl+Space'
  && partialQuickChat?.quickChat?.reuseTimeoutMinutes === 0);
const resetInvalidQuickChatShortcut = await adapter.http('PUT', '/api/preferences/quick-chat', {
  shortcut: 'Control+',
});
check('quick chat preferences fall back for malformed shortcuts like upstream normalization',
  resetInvalidQuickChatShortcut?.ok === true
  && resetInvalidQuickChatShortcut?.quickChat?.shortcut === 'Alt+Space'
  && resetInvalidQuickChatShortcut?.quickChat?.reuseTimeoutMinutes === 0);
const rejectedQuickChatBody = await adapter.http('PUT', '/api/preferences/quick-chat', null);
check('quick chat preferences reject non-object writes',
  rejectedQuickChatBody?.ok === false && rejectedQuickChatBody?.error === 'quick chat object required');
await adapter.http('PUT', '/api/preferences/quick-chat', {
  shortcut: 'Alt+Space',
  reuseTimeoutMinutes: 10,
});

const initialNotifications = await adapter.http('GET', '/api/preferences/notifications');
check('notification preferences expose upstream-compatible defaults',
  initialNotifications?.notifications?.chatCompletion === 'never'
  && initialNotifications?.notifications?.scheduledTaskCompletion === 'never'
  && initialNotifications?.notifications?.patrolCompletion === 'never');
const savedNotifications = await adapter.http('PUT', '/api/preferences/notifications', {
  notifications: {
    chatCompletion: 'when_session_unfocused',
    scheduledTaskCompletion: 'always',
    patrolCompletion: 'when_unfocused',
  },
});
check('notification preferences persist supported modes',
  savedNotifications?.ok === true
  && savedNotifications?.notifications?.chatCompletion === 'when_session_unfocused'
  && savedNotifications?.notifications?.scheduledTaskCompletion === 'always'
  && savedNotifications?.notifications?.patrolCompletion === 'when_unfocused');
const legacyNotificationPatch = await adapter.http('PATCH', '/api/preferences/notifications', {
  turnCompletion: 'when_unfocused',
});
check('notification preferences accept legacy turnCompletion patches',
  legacyNotificationPatch?.ok === true
  && legacyNotificationPatch?.notifications?.chatCompletion === 'when_unfocused'
  && legacyNotificationPatch?.notifications?.scheduledTaskCompletion === 'always');
const normalizedInvalidNotification = await adapter.http('PUT', '/api/preferences/notifications', {
  patrolCompletion: 'sometimes',
});
check('notification preferences normalize unsupported modes to never',
  normalizedInvalidNotification?.ok === true
  && normalizedInvalidNotification?.notifications?.patrolCompletion === 'never'
  && normalizedInvalidNotification?.notifications?.chatCompletion === 'when_unfocused');
const rejectedNotificationBody = await adapter.http('PUT', '/api/preferences/notifications', null);
check('notification preferences reject non-object writes',
  rejectedNotificationBody?.ok === false
  && rejectedNotificationBody?.error === 'notification preferences object required');
await adapter.http('PUT', '/api/preferences/notifications', {
  chatCompletion: 'never',
  scheduledTaskCompletion: 'never',
  patrolCompletion: 'never',
});

const permissionDefault = await adapter.http('GET', '/api/preferences/session-permission-default');
check('permission default is explicitly locked to ask without backend support',
  permissionDefault?.permissionMode === 'ask'
  && permissionDefault?.locked === true
  && Array.isArray(permissionDefault?.supportedModes)
  && permissionDefault.supportedModes.length === 1
  && permissionDefault.supportedModes[0] === 'ask');
const lockedPermissionDefault = await adapter.http('PUT', '/api/preferences/session-permission-default', {
  permissionMode: 'auto',
});
check('permission default writes fail closed instead of faking success',
  lockedPermissionDefault?.ok === false
  && lockedPermissionDefault?.locked === true
  && lockedPermissionDefault?.permissionMode === 'ask');
const lockedSessionPermission = await adapter.http('POST', '/api/session-permission-mode', {
  sessionPath: listed[0].path,
  mode: 'read_only',
});
check('session permission writes fail closed instead of faking read-only enforcement',
  lockedSessionPermission?.ok === false
  && lockedSessionPermission?.locked === true
  && lockedSessionPermission?.mode === 'ask');

const iframeBridgeSource = readFileSync(
  join(ROOT, 'ui/desktop/src/react/studio-backend/studio-backend-bridge.ts'),
  'utf8',
);
check('iframe bridge intercepts session permission mode requests',
  iframeBridgeSource.includes("pathname === '/api/session-permission-mode'"));
check('iframe bridge intercepts appearance preference requests',
  iframeBridgeSource.includes("pathname === '/api/preferences/appearance'"));
check('iframe bridge intercepts sidebar UI preference requests',
  iframeBridgeSource.includes("pathname === '/api/preferences/sidebar-ui'"));
check('iframe bridge intercepts quick chat preference requests',
  iframeBridgeSource.includes("pathname === '/api/preferences/quick-chat'"));
check('iframe bridge intercepts notification preference requests',
  iframeBridgeSource.includes("pathname === '/api/preferences/notifications'"));

// Pin / unpin persists locally and is reflected in GET /api/sessions
{
  const target = listed[0].sessionId;
  const pinned = await adapter.http('POST', '/api/sessions/pin', {
    path: listed[0].path,
    sessionId: target,
    pinned: true,
  });
  check('pin returns pinnedAt', pinned && pinned.ok === true && typeof pinned.pinnedAt === 'string');
  check('pin returns pinOrder', pinned && Number.isFinite(pinned.pinOrder));
  const afterPin = await adapter.http('GET', '/api/sessions');
  const pinnedRow = afterPin.find((s) => s.sessionId === target);
  check('pinned session appears in list', pinnedRow && pinnedRow.pinnedAt === pinned.pinnedAt);
  const unpinned = await adapter.http('POST', '/api/sessions/pin', {
    path: listed[0].path,
    sessionId: target,
    pinned: false,
  });
  check('unpin clears pinnedAt', unpinned && unpinned.ok === true && unpinned.pinnedAt === null);
  const afterUnpin = await adapter.http('GET', '/api/sessions');
  const unpinnedRow = afterUnpin.find((s) => s.sessionId === target);
  check('unpinned session has no pinnedAt', unpinnedRow && unpinnedRow.pinnedAt == null);
}

// ---- mock incremental streaming ----
{
  const created = await adapter.http('POST', '/api/sessions/new-detached', {});
  const sid = created.sessionId;
  const pushed = [];
  const turn = await adapter.ws({
    type: 'prompt',
    text: 'stream please',
    sessionId: sid,
    sessionPath: 'studio://' + sid,
    clientMessageId: 'c-stream',
    displayMessage: { text: 'stream please' },
  }, (ev) => pushed.push(ev));

  check('mock prompt marks streamed', turn.streamed === true);
  check('mock prompt pushes status streaming true first',
    pushed[0] && pushed[0].type === 'status' && pushed[0].isStreaming === true);
  check('mock prompt pushes session_user_message early',
    pushed.some((e) => e.type === 'session_user_message'));

  const deltaIdx = [];
  pushed.forEach((e, i) => { if (e.type === 'text_delta' && e.delta) deltaIdx.push(i); });
  check('mock prompt emits multiple text_delta chunks', deltaIdx.length >= 2);
  const joined = pushed.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  check('mock text_delta chunks reassemble the reply',
    joined.includes('mock fallback') || joined.includes('没有调用'));
  check('mock thinking arrives before or with text',
    pushed.some((e) => e.type === 'thinking_delta'));
  check('mock turn ends with turn_end + status false',
    pushed.some((e) => e.type === 'turn_end')
    && pushed[pushed.length - 1].type === 'status'
    && pushed[pushed.length - 1].isStreaming === false);

  // Incremental: first text_delta must arrive before the final status.
  const firstDelta = pushed.findIndex((e) => e.type === 'text_delta' && e.delta);
  const lastStatus = pushed.length - 1;
  check('first text_delta arrives before final status (incremental)',
    firstDelta >= 0 && firstDelta < lastStatus);
}

const calls = [];
let liveTranscript = [
  { role: 'user', text: 'hi', reasoning: '', tool_calls: [], tool_results: [] },
  { role: 'assistant', text: 'pong', reasoning: 'because', tool_calls: [], tool_results: [] },
];
let sendResolve;
let sendStarted = null;
global.window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    calls.push({ cmd, args });
    if (cmd === 'list_sessions') {
      return Promise.resolve([
        { id: 'agent-1', title: 'Hello', busy: false, live: true, messages: 2, turns: 1, status: 'idle', usage: null, provider: 'deepseek', model: 'deepseek-reasoner' },
        { id: 'agent-2', title: 'Cold', busy: false, live: false, messages: 1, turns: 1, status: 'idle', usage: null },
      ]);
    }
    if (cmd === 'list_agents') return Promise.resolve([]);
    if (cmd === 'create_agent') return Promise.resolve('agent-new');
    if (cmd === 'get_llm_config') return Promise.resolve({
      current: { provider: 'deepseek', model: 'deepseek-chat' },
      default: 'deepseek',
      providers: {
        mock: { model: 'mock-1' },
        deepseek: { model: 'deepseek-chat' },
      },
      model_lists: {
        mock: ['mock-1'],
        deepseek: ['deepseek-chat', 'deepseek-reasoner'],
      },
    });
    if (cmd === 'resume_session') return Promise.resolve(args.sessionId);
    if (cmd === 'retry_session_turn') {
      return Promise.resolve({ sessionId: args.sessionId, retried: true, target: args.target });
    }
    if (cmd === 'fork_session') {
      return Promise.resolve({ sessionId: 'agent-fork', sourceSessionId: args.sessionId, target: args.target });
    }
    if (cmd === 'send_message') {
      sendStarted = Date.now();
      // Grow transcript while the invoke is outstanding so poll can stream.
      liveTranscript = [
        ...liveTranscript,
        { role: 'user', text: args.text, reasoning: '', tool_calls: [], tool_results: [] },
        { role: 'assistant', text: '', reasoning: '', tool_calls: [], tool_results: [] },
      ];
      const asstIdx = liveTranscript.length - 1;
      return new Promise((resolve) => {
        sendResolve = resolve;
        const pieces = ['Hel', 'lo ', 'from ', 'Studio'];
        let i = 0;
        const step = () => {
          if (i < pieces.length) {
            liveTranscript[asstIdx].text += pieces[i];
            if (i === 0) liveTranscript[asstIdx].reasoning = 'r1';
            if (i === 1) liveTranscript[asstIdx].reasoning = 'r1r2';
            i += 1;
            setTimeout(step, 50);
          } else {
            setTimeout(() => resolve(undefined), 40);
          }
        };
        setTimeout(step, 10);
      });
    }
    if (cmd === 'steer_agent') return Promise.resolve(undefined);
    if (cmd === 'cancel_agent') return Promise.resolve(undefined);
    if (cmd === 'transcript') {
      return Promise.resolve(liveTranscript.map((m) => ({ ...m })));
    }
    return Promise.reject(new Error('unknown ' + cmd));
  },
};

check('api mode flips to tauri once invoke exists', api.mode() === 'tauri');
check('pickProvider falls back to configured provider without studio_status', await api.pickProvider() === 'deepseek');
const configuredStatus = await api.status();
check('status falls back to configured provider and model without studio_status',
  configuredStatus.provider === 'deepseek'
  && configuredStatus.providers.includes('deepseek')
  && configuredStatus.model === 'deepseek-chat'
  && /get_llm_config/.test(configuredStatus.note || ''));
calls.length = 0;
await api.create('mock');
check('create resolves model within explicitly selected provider',
  calls.some((call) => call.cmd === 'create_agent'
    && call.args.provider === 'mock'
    && call.args.model === 'mock-1'));
await adapter.http('POST', '/api/models/set', {
  provider: 'mock',
  modelId: 'mock-1',
});
const createdWithPending = await adapter.http('POST', '/api/sessions/new', {});
const sessionModels = await adapter.http(
  'GET',
  `/api/models?sessionPath=${encodeURIComponent(createdWithPending.path)}`,
);
check('model listing is session-aware for opened conversations',
  sessionModels.activeModel?.provider === 'mock'
  && sessionModels.activeModel?.id === 'mock-1'
  && sessionModels.models.some((model) =>
    model.provider === 'mock' && model.id === 'mock-1' && model.isCurrent === true));
const unmappedSessionModels = await adapter.http('GET', '/api/models?sessionPath=studio%3A%2F%2Fagent-unmapped');
check('unmapped existing session does not inherit pending new-chat model',
  unmappedSessionModels.activeModel?.provider === 'deepseek'
  && unmappedSessionModels.activeModel?.id === 'deepseek-chat');
const live = await api.sessions();
check('sessions call list_sessions', calls.some((c) => c.cmd === 'list_sessions') && live[0].id === 'agent-1');
const projectedLive = await adapter.http('GET', '/api/sessions');
check('sessions without backend timestamps do not become just-now on every refresh',
  projectedLive.every((session) => session.modified == null && session.created == null));
check('session projection preserves backend model metadata',
  projectedLive.some((session) =>
    session.sessionId === 'agent-1'
    && session.modelProvider === 'deepseek'
    && session.modelId === 'deepseek-reasoner'));
check('session projection falls back to configured host model',
  projectedLive.some((session) =>
    session.sessionId === 'agent-2'
    && session.modelProvider === 'deepseek'
    && session.modelId === 'deepseek-chat'));

// Runtime-state is the shell's stable projection for busy/error/tool activity.
// Keep this independent of the renderer so React/slot surfaces consume one
// normalized contract instead of inferring state from transcripts repeatedly.
{
  const originalSessions = api.sessions;
  const originalTranscript = api.transcript;
  api.sessions = async () => [
    { id: 'runtime-running', title: 'Running', busy: true, live: true, status: 'busy', messages: 2 },
    { id: 'runtime-error', title: 'Failed', busy: false, live: true, status: 'failed', error: 'provider offline', messages: 2 },
  ];
  api.transcript = async (id) => {
    if (id === 'runtime-running') {
      return [{
        role: 'assistant',
        text: '',
        reasoning: '',
        tool_calls: [{ id: 'tool-live', name: 'read_file', arguments: '{"path":"README.md"}' }],
        tool_results: [],
      }];
    }
    return [
      {
        role: 'assistant',
        text: '',
        reasoning: '',
        tool_calls: [{ id: 'tool-failed', name: 'fetch', arguments: '{}' }],
        tool_results: [],
      },
      {
        role: 'user',
        text: '',
        reasoning: '',
        tool_calls: [],
        tool_results: [{ tool_call_id: 'tool-failed', content: 'network denied', is_error: true }],
      },
    ];
  };

  const runtime = await adapter.http('GET', '/api/runtime-state');
  const running = runtime.sessions.find((session) => session.sessionId === 'runtime-running');
  const failed = runtime.sessions.find((session) => session.sessionId === 'runtime-error');
  check('runtime-state exposes running session and active tool',
    runtime.mode === 'tauri'
    && running?.status === 'running'
    && running?.activeToolCount === 1
    && running?.activeTools?.[0]?.name === 'read_file');
  check('runtime-state carries backend error and failed tool projection',
    failed?.status === 'error'
    && failed?.error === 'provider offline'
    && failed?.failedTools?.[0]?.error === 'network denied');

  const single = await adapter.http('GET', '/api/runtime-state/runtime-running');
  check('runtime-state supports single-session lookup',
    single?.sessionId === 'runtime-running' && single?.activeToolCount === 1);

  api.sessions = originalSessions;
  api.transcript = originalTranscript;
}

// Idle runtime projections reuse transcript parsing until the session version
// changes, while busy sessions always refresh for live tool state.
{
  const originalSessions = api.sessions;
  const originalTranscript = api.transcript;
  let messageCount = 2;
  let busy = false;
  let transcriptCalls = 0;
  api.sessions = async () => [{
    id: 'runtime-cache',
    title: 'Cached runtime',
    busy,
    live: true,
    status: busy ? 'busy' : 'idle',
    messages: messageCount,
    updated_at: 100,
  }];
  api.transcript = async () => {
    transcriptCalls += 1;
    return [{ role: 'assistant', text: 'cached', tool_calls: [], tool_results: [] }];
  };

  await adapter.http('GET', '/api/runtime-state');
  await adapter.http('GET', '/api/runtime-state');
  check('idle runtime-state reuses transcript cache', transcriptCalls === 1);

  const cachedSearch = await adapter.http(
    'GET',
    '/api/sessions/search?q=cached&phase=content&limit=20',
  );
  check('content search reuses idle runtime transcript cache',
    cachedSearch.results.some((row) => row.sessionId === 'runtime-cache')
    && transcriptCalls === 1);

  messageCount = 3;
  await adapter.http('GET', '/api/runtime-state');
  check('runtime transcript cache invalidates on message version change', transcriptCalls === 2);

  let releaseConcurrentTranscript = null;
  messageCount = 4;
  api.transcript = async () => {
    transcriptCalls += 1;
    return new Promise((resolve) => {
      releaseConcurrentTranscript = () => resolve([
        { role: 'assistant', text: 'shared pending transcript', tool_calls: [], tool_results: [] },
      ]);
    });
  };
  const pendingRuntime = adapter.http('GET', '/api/runtime-state');
  const pendingSearch = adapter.http(
    'GET',
    '/api/sessions/search?q=shared&phase=content&limit=20',
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('runtime and search share one inflight transcript request', transcriptCalls === 3);
  releaseConcurrentTranscript?.();
  await Promise.all([pendingRuntime, pendingSearch]);

  api.transcript = async () => {
    transcriptCalls += 1;
    return [{ role: 'assistant', text: 'busy', tool_calls: [], tool_results: [] }];
  };
  busy = true;
  await adapter.http('GET', '/api/runtime-state');
  await adapter.http('GET', '/api/runtime-state');
  check('busy runtime-state bypasses transcript cache', transcriptCalls === 5);

  api.sessions = originalSessions;
  api.transcript = originalTranscript;
}

const created = await adapter.http('POST', '/api/sessions/new-detached', {});
check('create_agent uses mock/mock-1',
  created.sessionId === 'agent-new'
  && created.path === 'studio://agent-new'
  && calls.some((c) => c.cmd === 'create_agent'
    && c.args.provider === 'mock' && c.args.model === 'mock-1'));

calls.length = 0;
const switched = await adapter.http('POST', '/api/sessions/switch', { path: 'studio://agent-2', sessionId: 'agent-2' });
check('cold session resumes without rebuilding its model driver',
  switched.sessionId === 'agent-2'
  && calls.some((c) => c.cmd === 'resume_session' && c.args.sessionId === 'agent-2')
  && !calls.some((c) => c.cmd === 'rebind_agent_model'));

const messages = await adapter.http('GET', '/api/sessions/messages?path=' + encodeURIComponent('studio://agent-1') + '&sessionId=agent-1');
check('transcript becomes history content',
  messages.messages[1].role === 'assistant' && messages.messages[1].content === 'pong' && messages.messages[1].thinking === 'because');
check('studio history exposes stable entry ids for branch actions',
  messages.messages[0].entryId === 'studio-entry:0:user'
  && messages.messages[1].entryId === 'studio-entry:1:assistant'
  && messages.messages[1].turnInputEntryId === 'studio-entry:0:user');

calls.length = 0;
const retriedTurn = await adapter.http('POST', '/api/sessions/turns/retry', {
  sessionId: 'agent-1',
  path: 'studio://agent-1',
  target: { role: 'assistant_turn', turnInputEntryId: 'studio-entry:0:user' },
  clientMessageId: 'retry-msg',
});
check('retry route invokes the explicit Studio branch command',
  retriedTurn?.ok === true
  && retriedTurn?.retried === true
  && calls.some((c) => c.cmd === 'retry_session_turn'
    && c.args.sessionId === 'agent-1'
    && c.args.target?.turnInputEntryId === 'studio-entry:0:user'
    && c.args.msgId === 'retry-msg'));

calls.length = 0;
const forkedTurn = await adapter.http('POST', '/api/sessions/fork', {
  sessionId: 'agent-1',
  path: 'studio://agent-1',
  target: { role: 'assistant', entryId: 'studio-entry:1:assistant' },
});
check('fork route invokes the explicit Studio branch command and projects the child locator',
  forkedTurn?.ok === true
  && forkedTurn?.sessionId === 'agent-fork'
  && forkedTurn?.sessionPath === 'studio://agent-fork'
  && calls.some((c) => c.cmd === 'fork_session'
    && c.args.sessionId === 'agent-1'
    && c.args.target?.entryId === 'studio-entry:1:assistant'));

// ---- tauri path: incremental deltas while send_message is in flight ----
{
  calls.length = 0;
  const pushed = [];
  const timestamps = [];
  const turn = await adapter.ws({
    type: 'prompt',
    text: 'hi',
    sessionId: 'agent-1',
    sessionPath: 'studio://agent-1',
    clientMessageId: 'c1',
    displayMessage: { text: 'hi' },
  }, (ev) => {
    pushed.push(ev);
    timestamps.push(Date.now());
  });

  check('prompt awaits send_message',
    calls.some((c) => c.cmd === 'send_message' && c.args.agentId === 'agent-1' && c.args.text === 'hi' && c.args.msgId === 'c1'));
  check('tauri prompt streamed flag', turn.streamed === true);

  const deltas = pushed.filter((e) => e.type === 'text_delta' && e.delta);
  check('tauri prompt emits multiple text_delta chunks', deltas.length >= 2);
  check('tauri text_delta reassembles',
    deltas.map((e) => e.delta).join('') === 'Hello from Studio');
  check('tauri thinking forwarded',
    pushed.some((e) => e.type === 'thinking_delta'));
  check('tauri prompt emits user + turn_end',
    pushed.some((e) => e.type === 'session_user_message') && pushed.some((e) => e.type === 'turn_end'));

  // Best-effort incremental: at least one delta should have been observed
  // before send_message resolved (sendStarted set when invoke began).
  const firstDeltaAt = timestamps[pushed.findIndex((e) => e.type === 'text_delta' && e.delta)];
  check('at least one text_delta arrived during in-flight send (best-effort)',
    sendStarted != null && firstDeltaAt != null && firstDeltaAt >= sendStarted);
  const joined = deltas.map((e) => e.delta).join('');
  check('second-turn deltas are ONLY A2 (no A1 concat)',
    joined === 'Hello from Studio' && !joined.includes('pong'));
}

// Push events carry both an absolute current-step snapshot and its delta.
// Text from different assistant steps may overlap or even be identical; those
// are distinct model output and must not be content-deduplicated across tools.
{
  let partialHandler = null;
  window.__TAURI__ = {
    event: {
      listen: async (_event, handler) => {
        partialHandler = handler;
        return () => { partialHandler = null; };
      },
    },
  };
  const baseline = [
    { role: 'user', text: 'old', reasoning: '', tool_calls: [], tool_results: [] },
    { role: 'assistant', text: 'old reply', reasoning: '', tool_calls: [], tool_results: [] },
  ];
  liveTranscript = baseline;
  global.window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'list_sessions') {
      return Promise.resolve([
        { id: 'agent-1', title: 'Race', busy: false, live: true, messages: liveTranscript.length, turns: 1, status: 'idle', usage: null },
      ]);
    }
    if (cmd === 'transcript') return Promise.resolve(liveTranscript.map((m) => structuredClone(m)));
    if (cmd === 'send_message') {
      return new Promise((resolve) => {
        setTimeout(() => {
          partialHandler?.({ payload: { agentId: args.agentId, text: 'abc', textDelta: 'abc', reasoning: '', reasoningDelta: '' } });
          liveTranscript = [
            ...baseline,
            { role: 'user', text: args.text, reasoning: '', tool_calls: [], tool_results: [] },
            { role: 'assistant', text: '', reasoning: '', tool_calls: [{ id: 'overlap-tool', name: 'read_file', arguments: '{"path":"x"}' }], tool_results: [] },
            { role: 'user', text: '', reasoning: '', tool_calls: [], tool_results: [{ tool_call_id: 'overlap-tool', content: 'ok', is_error: false }] },
          ];
        }, 10);
        setTimeout(() => {
          partialHandler?.({ payload: { agentId: args.agentId, text: 'cdef', textDelta: 'cdef', reasoning: '', reasoningDelta: '' } });
          liveTranscript = [
            ...liveTranscript,
            { role: 'assistant', text: 'cdef', reasoning: '', tool_calls: [{ id: 'same-tool', name: 'read_file', arguments: '{"path":"y"}' }], tool_results: [] },
            { role: 'user', text: '', reasoning: '', tool_calls: [], tool_results: [{ tool_call_id: 'same-tool', content: 'ok', is_error: false }] },
          ];
        }, 60);
        setTimeout(() => {
          partialHandler?.({ payload: { agentId: args.agentId, text: 'cdef', textDelta: 'cdef', reasoning: '', reasoningDelta: '' } });
          liveTranscript = [...liveTranscript, { role: 'assistant', text: 'cdef', reasoning: '', tool_calls: [], tool_results: [] }];
          resolve(undefined);
        }, 110);
      });
    }
    return Promise.resolve(undefined);
  };

  const progress = [];
  await api.sendWithProgress('agent-1', 'race', 'race-1', (event) => progress.push(event));
  const text = progress.filter((event) => event.kind === 'text_delta').map((event) => event.delta).join('');
  check('snapshot+delta keeps overlapping assistant steps exact', text === 'abccdefcdef');
  const snapshot = progress.find((event) => event.kind === 'assistant_snapshot');
  check('assistant snapshot preserves empty pre-tool slots',
    Array.isArray(snapshot?.segments)
    && snapshot.segments.length === 3
    && snapshot.segments[0] === ''
    && snapshot.segments[1] === 'cdef'
    && snapshot.segments[2] === 'cdef');
  check('push+transcript race emits each completed tool once',
    progress.filter((event) => event.kind === 'tool_start').length === 2
    && progress.filter((event) => event.kind === 'tool_end').length === 2);
  window.__TAURI__ = null;
}

// Stop invalidates the current progress callback before cancel_agent resolves.
// A new prompt gets a distinct stream and late output from the stopped turn
// cannot leak into either transcript.
{
  const originalSessions = api.sessions;
  const originalSendWithProgress = api.sendWithProgress;
  const originalCancel = api.cancel;
  let oldProgress = null;
  let resolveOldSend = null;
  let sendCount = 0;

  api.sessions = async () => [
    { id: 'agent-race', title: 'Race', busy: false, live: true, messages: 0, turns: 0, status: 'idle' },
  ];
  api.cancel = async () => undefined;
  api.sendWithProgress = async (_agentId, _text, _msgId, onProgress) => {
    sendCount += 1;
    if (sendCount === 1) {
      oldProgress = onProgress;
      await new Promise((resolve) => { resolveOldSend = resolve; });
      return true;
    }
    onProgress({ kind: 'text_delta', delta: 'new answer' });
    return true;
  };

  const oldEvents = [];
  const oldTurn = adapter.ws({
    type: 'prompt',
    text: 'old prompt',
    sessionId: 'agent-race',
    sessionPath: 'studio://agent-race',
    clientMessageId: 'old-message',
  }, (event) => oldEvents.push(event));
  while (!oldProgress) await new Promise((resolve) => setTimeout(resolve, 0));

  const oldStreamId = oldEvents[0]?.streamId;
  check('prompt events carry one streamId',
    typeof oldStreamId === 'string'
    && oldEvents.every((event) => event.streamId === oldStreamId));

  const stopEvents = [];
  await adapter.ws({
    type: 'abort',
    sessionId: 'agent-race',
    sessionPath: 'studio://agent-race',
    streamId: oldStreamId,
  }, (event) => stopEvents.push(event));
  const countAfterStop = oldEvents.length;

  oldProgress({ kind: 'text_delta', delta: 'late old answer' });
  oldProgress({ kind: 'tool_end', id: 'late-tool', name: 'bash', success: true, output: 'late' });
  oldProgress({ kind: 'assistant_snapshot', segments: ['late old answer'] });

  const newEvents = [];
  await adapter.ws({
    type: 'prompt',
    text: 'new prompt',
    sessionId: 'agent-race',
    sessionPath: 'studio://agent-race',
    clientMessageId: 'new-message',
  }, (event) => newEvents.push(event));
  resolveOldSend();
  await oldTurn;

  check('accepted Stop reports aborted terminal events for stopped stream',
    stopEvents.some((event) => event.type === 'abort_result' && event.status === 'accepted')
    && stopEvents.some((event) => event.type === 'turn_end' && event.aborted === true)
    && stopEvents.every((event) => event.streamId === oldStreamId));
  check('stopped turn drops all late progress and final events',
    oldEvents.length === countAfterStop
    && !oldEvents.some((event) => event.delta === 'late old answer' || event.id === 'late-tool'));
  check('next prompt uses a new isolated stream',
    newEvents[0]?.streamId
    && newEvents[0].streamId !== oldStreamId
    && newEvents.every((event) => event.streamId === newEvents[0].streamId)
    && newEvents.some((event) => event.type === 'text_delta' && event.delta === 'new answer'));

  api.sessions = originalSessions;
  api.sendWithProgress = originalSendWithProgress;
  api.cancel = originalCancel;
}

// After iframe/plugin recovery the bridge has no active-turn token. Stop must
// still reach Studio because the backend turn may have survived the reload.
{
  const originalCancel = api.cancel;
  const cancelled = [];
  api.cancel = async (id) => { cancelled.push(id); };
  const recoveredEvents = [];
  await adapter.ws({
    type: 'abort',
    sessionId: 'agent-recovered',
    sessionPath: 'studio://agent-recovered',
    streamId: 'stream-lost-with-old-bridge',
  }, (event) => recoveredEvents.push(event));
  check('recovered Stop still calls cancel_agent',
    cancelled.length === 1 && cancelled[0] === 'agent-recovered');
  check('recovered Stop is not rejected as stale',
    !recoveredEvents.some((event) => event.type === 'abort_result' && event.status === 'rejected')
    && recoveredEvents.some((event) => event.type === 'turn_end' && event.aborted === true));
  api.cancel = originalCancel;
}

// Archiving a running session seals its callback before soft-unbind awaits.
{
  const originalSessions = api.sessions;
  const originalSendWithProgress = api.sendWithProgress;
  const originalSoftUnbind = api.softUnbind;
  let progress = null;
  let finishSend = null;
  const softUnbound = [];
  api.sessions = async () => [
    { id: 'agent-delete-race', busy: false, live: true, status: 'idle' },
  ];
  api.sendWithProgress = async (_id, _text, _msgId, onProgress) => {
    progress = onProgress;
    await new Promise((resolve) => { finishSend = resolve; });
    return true;
  };
  api.softUnbind = async (id) => { softUnbound.push(id); };

  const events = [];
  const sending = adapter.ws({
    type: 'prompt',
    text: 'run forever',
    sessionId: 'agent-delete-race',
    sessionPath: 'studio://agent-delete-race',
    clientMessageId: 'delete-race-message',
  }, (event) => events.push(event));
  while (!progress) await new Promise((resolve) => setTimeout(resolve, 0));
  const archived = await adapter.http('POST', '/api/sessions/archive', {
    sessionId: 'agent-delete-race',
  });
  const countAfterDelete = events.length;
  progress({ kind: 'text_delta', delta: 'late deleted output' });
  progress({ kind: 'tool_end', id: 'late-deleted-tool', name: 'bash', success: true });
  finishSend();
  await sending;

  check('running archive soft-unbinds selected agent',
    archived?.ok === true && archived?.archived === true
    && softUnbound.length === 1 && softUnbound[0] === 'agent-delete-race');
  check('running archive drops late progress and terminal events',
    events.length === countAfterDelete
    && !events.some((event) => event.delta === 'late deleted output' || event.id === 'late-deleted-tool'));

  api.sessions = originalSessions;
  api.sendWithProgress = originalSendWithProgress;
  api.softUnbind = originalSoftUnbind;
}

// steer must pass msgId
{
  calls.length = 0;
  await adapter.ws({
    type: 'interject',
    text: 'nudge',
    sessionId: 'agent-1',
    sessionPath: 'studio://agent-1',
    clientMessageId: 'steer-1',
  });
  check('steer_agent receives msgId',
    calls.some((c) => c.cmd === 'steer_agent'
      && c.args.agentId === 'agent-1'
      && c.args.text === 'nudge'
      && c.args.msgId === 'steer-1'));
}

const sent = [];
const cw = { postMessage(msg) { sent.push(msg); } };
const frameListeners = {};
const frame = {
  contentWindow: cw,
  addEventListener(type, fn) { (frameListeners[type] ||= []).push(fn); },
  removeEventListener() {},
};
const detach = host.attach(frame);
check('attach says hello immediately',
  sent.some((m) => m.source === 'openhanako-shell' && m.type === 'studio-backend-hello'));

messageHandlers[0]({
  source: cw,
  data: {
    source: 'openhanako-studio-bridge',
    type: 'request',
    requestId: 'sb-9',
    op: 'http',
    method: 'GET',
    path: '/api/sessions',
  },
});
await new Promise((resolve) => setTimeout(resolve, 20));
const response = sent.find((m) => m.type === 'response' && m.requestId === 'sb-9');
check('host bridge correlates requestId',
  response && response.ok === true && Array.isArray(response.result) && response.result[0].sessionId === 'agent-1');

// Host bridge pushes mid-turn events for WS
{
  sent.length = 0;
  // Reset live transcript growth for a short streamed turn
  liveTranscript = [
    { role: 'user', text: 'x', reasoning: '', tool_calls: [], tool_results: [] },
    { role: 'assistant', text: 'done', reasoning: '', tool_calls: [], tool_results: [] },
  ];
  global.window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'send_message') return Promise.resolve(undefined);
    if (cmd === 'transcript') return Promise.resolve(liveTranscript.map((m) => ({ ...m })));
    if (cmd === 'list_sessions') {
      return Promise.resolve([
        { id: 'agent-1', title: 'Hello', busy: false, live: true, messages: 2, turns: 1, status: 'idle', usage: null },
      ]);
    }
    if (cmd === 'resume_session') return Promise.resolve(args.sessionId);
    return Promise.resolve(undefined);
  };

  messageHandlers[0]({
    source: cw,
    data: {
      source: 'openhanako-studio-bridge',
      type: 'request',
      requestId: 'sb-ws-1',
      op: 'ws',
      message: {
        type: 'prompt',
        text: 'x',
        sessionId: 'agent-1',
        sessionPath: 'studio://agent-1',
        clientMessageId: 'cx',
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const events = sent.filter((m) => m.type === 'event' && m.requestId === 'sb-ws-1');
  const final = sent.find((m) => m.type === 'response' && m.requestId === 'sb-ws-1');
  check('host bridge pushes event messages for WS turns', events.length >= 2);
  check('host bridge event payloads are chat events',
    events.some((m) => m.event && m.event.type === 'session_user_message'));
  check('host bridge final WS ack is empty when streamed',
    final && final.ok && final.result && final.result.streamed === true
    && Array.isArray(final.result.events) && final.result.events.length === 0);
}


// Archive/restore invalidates cached idle transcripts so restored sessions
// hydrate fresh state even when their message/version fields are unchanged.
{
  const originalSessions = api.sessions;
  const originalTranscript = api.transcript;
  const originalSoftUnbind = api.softUnbind;
  const originalResume = api.resume;
  let transcriptCalls = 0;
  api.sessions = async () => [{
    id: 'cache-lifecycle',
    title: 'Cache lifecycle',
    busy: false,
    live: true,
    status: 'idle',
    messages: 1,
    updated_at: 77,
  }];
  api.transcript = async () => {
    transcriptCalls += 1;
    return [{ role: 'assistant', text: `snapshot-${transcriptCalls}`, tool_calls: [], tool_results: [] }];
  };
  api.softUnbind = async (id) => id;
  api.resume = async (id) => id;

  await adapter.http('GET', '/api/runtime-state');
  await adapter.http('GET', '/api/runtime-state');
  check('lifecycle test starts with cached idle transcript', transcriptCalls === 1);
  await adapter.http('POST', '/api/sessions/archive', { sessionId: 'cache-lifecycle' });
  await adapter.http('POST', '/api/sessions/restore', { sessionId: 'cache-lifecycle' });
  await adapter.http('GET', '/api/runtime-state');
  check('restore reloads transcript after archive cache invalidation', transcriptCalls === 2);

  api.sessions = originalSessions;
  api.transcript = originalTranscript;
  api.softUnbind = originalSoftUnbind;
  api.resume = originalResume;
}

// Archive is reversible: soft-unbind keeps JSONL/history, hides the session
// from the active list, and restore resumes it. Permanent archived delete is
// the operation that disposes the Studio agent.
{
  calls.length = 0;
  const archived = await adapter.http('POST', '/api/sessions/archive', { sessionId: 'agent-1' });
  check('archive soft-unbinds agent without disposing history',
    archived && archived.ok === true && archived.archived === true
    && calls.some((c) => c.cmd === 'soft_unbind_agent' && c.args.agentId === 'agent-1')
    && !calls.some((c) => c.cmd === 'dispose_agent'));
  const archivedRows = await adapter.http('GET', '/api/sessions/archived');
  const archivedAgent = archivedRows.find((row) => row.sessionId === 'agent-1') || null;
  check('archived session is listed', archivedRows.some((row) => row.sessionId === 'agent-1'));
  const activeRows = await adapter.http('GET', '/api/sessions');
  check('archived session is hidden from active list', !activeRows.some((row) => row.sessionId === 'agent-1'));
  const runtimeAfterArchive = await adapter.http('GET', '/api/runtime-state');
  check('archived session is hidden from runtime activity',
    !runtimeAfterArchive.sessions.some((row) => row.sessionId === 'agent-1'));
  const archivedRuntimeLookup = await adapter.http('GET', '/api/runtime-state/agent-1');
  check('single runtime lookup treats archived session as unavailable',
    archivedRuntimeLookup?.code === 'session_not_found');
  const renamedArchived = await adapter.http('POST', '/api/sessions/rename', {
    sessionId: 'agent-1',
    title: 'Hello archived agent',
  });
  const renamedArchivedRows = await adapter.http('GET', '/api/sessions/archived');
  check('rename updates archived session metadata',
    renamedArchived?.ok === true
    && renamedArchivedRows.some((row) => row.sessionId === 'agent-1' && row.title === 'Hello archived agent'));

  calls.length = 0;
  const restored = await adapter.http('POST', '/api/sessions/restore', { sessionId: 'agent-1' });
  check('restore resumes archived agent',
    restored && restored.ok === true && restored.restored === true
    && calls.some((c) => c.cmd === 'resume_session' && c.args.sessionId === 'agent-1'));
  const restoredModels = await adapter.http('GET', '/api/models?sessionPath=studio%3A%2F%2Fagent-1');
  check('restore preserves archived session model metadata',
    !!archivedAgent?.modelProvider
    && !!archivedAgent?.modelId
    && restoredModels.activeModel?.provider === archivedAgent.modelProvider
    && restoredModels.activeModel?.id === archivedAgent.modelId);
}

// Standalone session search mirrors the server's title/content phases and
// searches transcript text without requiring the full React server.
{
  const titleSearch = await adapter.http('GET', '/api/sessions/search?q=Hello&phase=title&limit=20');
  check('standalone title search returns projected sessions',
    titleSearch && titleSearch.phase === 'title'
    && titleSearch.results.some((row) => row.sessionId === 'agent-1' && /hello/i.test(row.title || '')));

  const contentSearch = await adapter.http('GET', '/api/sessions/search?q=done&phase=content&limit=20');
  check('standalone content search returns snippets',
    contentSearch && contentSearch.phase === 'content'
    && contentSearch.results.some((row) =>
      row.sessionId === 'agent-1'
      && row.matchKind === 'content'
      && /done/i.test(row.snippet || '')));

  await adapter.http('POST', '/api/sessions/rename', { sessionId: 'agent-1', title: 'Disposable title' });
  await adapter.http('POST', '/api/sessions/pin', { sessionId: 'agent-1', pinned: true });
  await adapter.http('POST', '/api/sessions/archive', { sessionId: 'agent-1' });
  calls.length = 0;
  const deletedArchived = await adapter.http('POST', '/api/sessions/archived/delete', { sessionId: 'agent-1' });
  check('permanent delete disposes archived session', deletedArchived?.ok === true);
  const afterPermanentDelete = await adapter.http('GET', '/api/sessions/archived');
  check('permanent delete removes archived metadata',
    !afterPermanentDelete.some((row) => row.sessionId === 'agent-1'));
  const activeAfterPermanentDelete = await adapter.http('GET', '/api/sessions');
  check('disposed session stays hidden while backend list is stale',
    !activeAfterPermanentDelete.some((row) => row.sessionId === 'agent-1'));
  const runtimeAfterPermanentDelete = await adapter.http('GET', '/api/runtime-state');
  check('disposed session stays hidden from runtime state',
    !runtimeAfterPermanentDelete.sessions.some((row) => row.sessionId === 'agent-1'));
  const searchAfterPermanentDelete = await adapter.http(
    'GET',
    '/api/sessions/search?q=Hello&phase=title&limit=20',
  );
  check('disposed session stays hidden from search',
    !searchAfterPermanentDelete.results.some((row) => row.sessionId === 'agent-1'));
}

// Busy session must refuse a second prompt (send lock).
{
  calls.length = 0;
  global.window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'list_sessions') {
      return Promise.resolve([
        { id: 'busy-1', title: 'Busy', busy: true, live: true, messages: 1, turns: 1, status: 'running', usage: null },
      ]);
    }
    if (cmd === 'send_message') return Promise.reject(new Error('should not send'));
    if (cmd === 'transcript') return Promise.resolve([]);
    return Promise.resolve(undefined);
  };
  // Clear module cache so api/adapter see new invoke? They close over tauri.invoke
  // which reads window each call — good.
  const pushed = [];
  const turn = await adapter.ws({
    type: 'prompt',
    text: 'second',
    sessionId: 'busy-1',
    sessionPath: 'studio://busy-1',
    clientMessageId: 'c-busy',
  }, (ev) => pushed.push(ev));
  check('busy prompt refuses with session_busy',
    pushed.some((e) => e.type === 'error' && e.code === 'session_busy'));
  check('busy prompt does not call send_message',
    !calls.some((c) => c.cmd === 'send_message'));
  check('busy prompt still reports streamed envelope', turn.streamed === true);
}


detach();
check('detach removes the message listener', messageHandlers.length === 0);

if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('studio bridge: ok');
