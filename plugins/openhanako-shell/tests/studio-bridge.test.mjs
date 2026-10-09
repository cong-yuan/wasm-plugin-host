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
api.projectCatalogAvailable = () => false;
api.automationSchedulerAvailable = () => false;
const host = studio.require('lib/host-bridge');

let invokeError = null;
try { await tauri.invoke('list_sessions'); } catch (err) { invokeError = err; }
check('invoke rejects with a clear error when Tauri is missing',
  invokeError && /Tauri invoke is not available/.test(invokeError.message));
check('api mode is mock without invoke', api.mode() === 'mock');
{
  const calls = [];
  studio.hostAction = async (action) => {
    calls.push(action);
    if (action.command === 'transcript') return [];
    if (action.command === 'chat_partial') return null;
    if (action.command === 'send_message_with_images') return true;
    throw new Error(`unexpected host command: ${action.command}`);
  };
  const progress = [];
  await api.sendWithProgress(
    'image-session',
    'describe this',
    'image-message',
    (event) => progress.push(event),
    { images: [{ data: 'aGVsbG8=', mimeType: 'image/png', detail: 'auto' }] },
  );
  const send = calls.find((action) => action.command === 'send_message_with_images');
  check('native image send uses the Studio image command', !!send);
  check('native image payload crosses the bridge unchanged',
    send?.args?.images?.[0]?.data === 'aGVsbG8=' && send?.args?.images?.[0]?.mimeType === 'image/png');
  check('native image send still completes the incremental API path',
    progress.some((event) => event.kind === 'assistant_snapshot'));
  studio.hostAction = null;
}

{
  const calls = [];
  studio.hostAction = async (action) => {
    calls.push(action);
    if (action.command === 'complete_session_todos') {
      return [{ content: 'read', status: 'completed' }, { content: 'write', status: 'completed' }];
    }
    throw new Error(`unexpected host command: ${action.command}`);
  };
  const capabilities = await adapter.http('GET', '/api/capabilities');
  check('Studio capability registry exposes persisted todo mutation',
    capabilities?.capabilities?.sessionTodoMutation === true);
  const result = await adapter.http('POST', '/api/sessions/todos/complete', {
    path: 'studio://todo-session',
  });
  const call = calls.find((action) => action.command === 'complete_session_todos');
  check('todo completion uses the Studio native command',
    result?.ok === true && result?.todos?.length === 0 && !!call);
  check('todo completion resolves the session id from studio path',
    call?.args?.agentId === 'todo-session');
  check('todo completion returns completed snapshot for the bridge',
    result?.completed?.length === 2 && result.completed.every((todo) => todo.status === 'completed'));
  studio.hostAction = async (action) => {
    if (action.command === 'complete_session_todos') return undefined;
    throw new Error('unexpected host command');
  };
  const missingTodoAck = await adapter.http('POST', '/api/sessions/todos/complete', {
    sessionId: 'todo-session',
  });
  check('missing native TODO snapshot is not converted into fake success',
    missingTodoAck?.ok === false && missingTodoAck?.code === 'todo_mutation_failed');
  studio.hostAction = null;
}

{
  const calls = [];
  studio.hostAction = async (action) => {
    calls.push(action);
    if (action.command === 'fresh_compact_session') {
      return { fresh: true, reason: 'manual', tokensBefore: null, tokensAfter: null };
    }
    throw new Error(`unexpected host command: ${action.command}`);
  };
  const capabilities = await adapter.http('GET', '/api/capabilities');
  check('Studio capability registry exposes fresh session compaction',
    capabilities?.capabilities?.sessionCompaction === true);
  const result = await adapter.http('POST', '/api/sessions/fresh-compact', {
    path: 'studio://compact-session',
  });
  const call = calls.find((action) => action.command === 'fresh_compact_session');
  check('fresh compact uses the Studio native command',
    result?.ok === true && result?.fresh === true && !!call);
  check('fresh compact resolves the session id from studio path',
    call?.args?.agentId === 'compact-session');
  studio.hostAction = null;
}

const unsupportedFileSurface = await adapter.http('GET', '/api/workbench/files');
check('unsupported file/workbench surface fails closed',
  unsupportedFileSurface?.ok === false
  && unsupportedFileSurface?.code === 'capability_unavailable'
  && unsupportedFileSurface?.__httpStatus === 501);
const capabilitiesBeforeFileWork = await adapter.http('GET', '/api/capabilities');
check('capability registry does not advertise unsupported file surfaces',
  capabilitiesBeforeFileWork?.capabilities?.fileWorkbench === false
  && capabilitiesBeforeFileWork?.capabilities?.fileHistory === false
  && capabilitiesBeforeFileWork?.capabilities?.resourceIO === false
  && capabilitiesBeforeFileWork?.capabilities?.generatedResourcePreview === false);

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
const assignmentFolder = await adapter.http('POST', '/api/session-projects/folders', { name: 'assignment-test-folder' });
const assignmentProject = await adapter.http('POST', '/api/session-projects/projects', {
  name: 'assignment-test-project', folderId: assignmentFolder?.folder?.id,
});
const assignmentSaved = await adapter.http('POST', '/api/session-projects/session-assignment', {
  sessionPath: 'studio://agent-1', projectId: assignmentProject?.project?.id,
});
check('session assignment rejects dangling project ids',
  assignmentSaved?.ok === true && assignmentSaved?.assignment?.projectId === assignmentProject?.project?.id);
const assignmentRead = await adapter.http('GET', '/api/session-projects/session-assignment?sessionPath=' + encodeURIComponent('studio://agent-1'));
check('session assignment can be read back by session path',
  assignmentRead?.assignment?.sessionPath === 'studio://agent-1'
  && assignmentRead?.assignment?.project?.id === assignmentProject?.project?.id);
const missingAssignmentProject = await adapter.http('POST', '/api/session-projects/session-assignment', {
  sessionPath: 'studio://agent-1', projectId: 'missing-project-id',
});
check('session assignment rejects unknown projects',
  missingAssignmentProject?.error === 'project not found');

await adapter.http('POST', '/api/session-projects/session-assignment', {
  sessionPath: 'studio://agent-1', projectId: null,
});
await adapter.http('DELETE', '/api/session-projects/projects/' + encodeURIComponent(assignmentProject?.project?.id || ''));
await adapter.http('DELETE', '/api/session-projects/folders/' + encodeURIComponent(assignmentFolder?.folder?.id || ''));

const thinkingLevelLocked = await adapter.http('GET', '/api/session-thinking-level');
check('thinking level is explicitly locked when Studio has no control',
  thinkingLevelLocked?.thinkingLevel === null
  && thinkingLevelLocked?.locked === true
  && thinkingLevelLocked?.code === 'capability_unavailable');
const thinkingLevelWriteLocked = await adapter.http('POST', '/api/session-thinking-level', { level: 'high' });
check('thinking level writes fail closed without Studio control',
  thinkingLevelWriteLocked?.ok === false
  && thinkingLevelWriteLocked?.code === 'capability_unavailable'
  && thinkingLevelWriteLocked?.code === 'capability_unavailable');

const permissionDefault = await adapter.http('GET', '/api/preferences/session-permission-default');
const agentSwitchLocked = await adapter.http('POST', '/api/agents/switch', { agentId: 'other-agent' });
check('agent switching fails closed without a Studio primary-agent command',
  agentSwitchLocked?.ok === false && agentSwitchLocked?.code === 'capability_unavailable');
const visionCapability = await adapter.http('GET', '/api/models/auxiliary-vision');
check('auxiliary vision reports missing Studio capability explicitly',
  visionCapability?.available === false && visionCapability?.code === 'capability_unavailable');
const capabilities = await adapter.http('GET', '/api/capabilities');
check('Studio capability registry exposes real and unavailable input controls',
  capabilities?.source === 'studio'
  && capabilities?.capabilities?.modelSwitch === true
  && capabilities?.capabilities?.uploadBlob === false
  && capabilities?.capabilities?.thinkingLevel === false
  && capabilities?.capabilities?.permissionMode === false
  && capabilities?.capabilities?.sessionProjects === true);

const uploadCapability = await adapter.http('POST', '/api/upload-blob', { name: 'x.png', base64Data: 'AA==', mimeType: 'image/png' });
check('blob upload reports missing Studio capability explicitly',
  uploadCapability?.ok === false && uploadCapability?.code === 'capability_unavailable');

// A real bridge can exist while a particular host command is missing (mixed
// host/plugin versions). Every native surface must report capability_unavailable
// instead of leaking a raw "unknown command" error or claiming success.
{
  studio.hostAction = async (action) => {
    if (action.command === 'list_sessions') {
      return [{ id: 'mixed-host-session', title: 'Mixed host', busy: false, live: true, status: 'idle' }];
    }
    if (action.command === 'transcript') return [];
    if (action.command === 'chat_partial') return null;
    throw new Error('unknown backend command: ' + action.command);
  };

  const mixedUpload = await adapter.http('POST', '/api/upload-blob', {
    sessionId: 'mixed-host-session',
    name: 'x.txt',
    base64Data: 'eA==',
    mimeType: 'text/plain',
  });
  check('mixed host upload command fails closed', mixedUpload?.ok === false && mixedUpload?.code === 'capability_unavailable');

  const mixedTodos = await adapter.http('POST', '/api/sessions/todos/complete', {
    path: 'studio://mixed-host-session',
  });
  check('mixed host todo command fails closed', mixedTodos?.ok === false && mixedTodos?.code === 'capability_unavailable');

  const mixedCompact = await adapter.http('POST', '/api/sessions/fresh-compact', {
    path: 'studio://mixed-host-session',
  });
  check('mixed host compact command fails closed', mixedCompact?.ok === false && mixedCompact?.code === 'capability_unavailable');
  const mixedDeleted = await adapter.http('POST', '/api/sessions/continue-deleted-agent', {
    path: 'studio://mixed-host-session',
  });
  check('mixed host deleted-agent continuation fails closed', mixedDeleted?.ok === false && mixedDeleted?.code === 'capability_unavailable');

  const mixedSummary = await adapter.http('GET', '/api/sessions/summary', {
    path: 'studio://mixed-host-session',
  });
  check('mixed host summary command fails closed', mixedSummary?.code === 'capability_unavailable');

  const mixedFolders = await adapter.http('GET', '/api/sessions/authorized-folders', {
    path: 'studio://mixed-host-session',
  });
  check('mixed host folder-scope command fails closed', mixedFolders?.ok === false && mixedFolders?.code === 'capability_unavailable');
  const mixedFolderPatch = await adapter.http('PATCH', '/api/sessions/authorized-folders', {
    path: 'studio://mixed-host-session',
    action: 'set',
    folders: [],
  });
  check('mixed host folder-scope patch command fails closed', mixedFolderPatch?.ok === false && mixedFolderPatch?.code === 'capability_unavailable');

  const mixedTurn = await adapter.ws({
    type: 'prompt',
    sessionId: 'mixed-host-session',
    sessionPath: 'studio://mixed-host-session',
    text: 'send an image',
    images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
    clientMessageId: 'mixed-image-1',
  });
  const mixedError = (mixedTurn?.events || []).find((event) => event.type === 'error');
  check('mixed host image turn exposes capability code', mixedError?.code === 'capability_unavailable');
  const mixedCapabilities = await adapter.http('GET', '/api/capabilities');
  check('mixed host capability cache disables upload after first failure', mixedCapabilities?.capabilities?.uploadBlob === false);
  check('mixed host capability cache disables todo after first failure', mixedCapabilities?.capabilities?.sessionTodoMutation === false);
  check('mixed host capability cache disables compact after first failure', mixedCapabilities?.capabilities?.sessionCompaction === false);
  check('mixed host capability cache disables deleted-agent continuation after first failure', mixedCapabilities?.capabilities?.deletedAgentContinuation === false);
  check('mixed host capability cache disables summary after first failure', mixedCapabilities?.capabilities?.sessionSummary === false);
  check('mixed host capability cache disables authorized folders after first failure', mixedCapabilities?.capabilities?.authorizedFolders === false);
  studio.hostAction = async (action) => {
    if (action.command === 'list_sessions') {
      return [{ id: 'workbench-session', title: 'Workbench', busy: false, live: true, status: 'idle' }];
    }
    if (action.command === 'workbench_list_files') {
      return {
        rootId: action.args.rootId,
        mountId: action.args.rootId,
        subdir: action.args.subdir,
        files: [{ name: 'hello.txt', isDir: false, size: 5 }],
      };
    }
    if (action.command === 'workbench_search_files') {
      return {
        rootId: action.args.rootId,
        mountId: action.args.rootId,
        query: action.args.query,
        results: [{ name: 'hello.txt', relativePath: 'hello.txt', isDir: false }],
      };
    }
    if (action.command === 'workbench_read_file') {
      return {
        exists: true,
        content: 'hello',
        version: 'v1',
        etag: '"v1"',
        mimeType: 'text/plain; charset=utf-8',
        size: 5,
        mtimeMs: 123,
        filename: action.args.name,
      };
    }
    if (action.command === 'workbench_write_file') {
      return {
        ok: true,
        version: 'v2',
        files: [{ name: action.args.name, isDir: false, size: String(action.args.content || '').length }],
      };
    }
    if (action.command === 'workbench_rename_file') {
      return {
        ok: true,
        action: 'rename',
        version: 'v3',
        files: [{ name: action.args.newName, isDir: false, size: 5 }],
      };
    }
    if (action.command === 'workbench_move_file') {
      return {
        ok: true,
        action: 'move',
        version: 'v4',
        rootId: action.args.rootId,
        subdir: action.args.destSubdir,
        files: [{ name: action.args.name, isDir: false, size: 5 }],
      };
    }
    if (action.command === 'workbench_safe_delete') {
      return {
        ok: true,
        action: 'safeDelete',
        trashId: 'trash-1',
        version: 'v5',
        files: [],
      };
    }
    if (action.command === 'workbench_upload_file') {
      return {
        ok: true,
        action: 'upload',
        name: action.args.name,
        version: 'v6',
        size: 5,
        files: [{ name: action.args.name, isDir: false, size: 5 }],
      };
    }
    if (action.command === 'file_history_list_files') {
      return {
        files: [{
          relPath: 'src/hello.txt',
          deletedAt: null,
          lastCapturedAt: 1234,
          snapshotCount: 3,
        }],
      };
    }
    if (action.command === 'file_history_list_versions') {
      return {
        versions: [{
          id: 7,
          capturedAt: 1234,
          origin: 'event',
          opContext: 'editor.save',
          rawSize: 5,
        }],
      };
    }
    if (action.command === 'file_history_get_snapshot') {
      return {
        relPath: 'src/hello.txt',
        capturedAt: 1234,
        origin: 'event',
        content: 'hello',
      };
    }
    if (action.command === 'file_history_restore') {
      return {
        ok: true,
        relPath: 'src/hello.txt',
      };
    }
    if (action.command === 'checkpoint_list') {
      return {
        checkpoints: [{
          id: '1700000000_ab12',
          ts: 1700000000000,
          tool: 'edit',
          source: 'llm',
          reason: 'tool-edit',
          path: '/workspace/hello.txt',
          size: 5,
        }],
      };
    }
    if (action.command === 'checkpoint_create_user_edit') {
      return {
        ok: true,
        checkpoint: {
          id: '1700000001_cd34',
          path: action.args.filePath,
          reason: action.args.reason,
        },
      };
    }
    if (action.command === 'checkpoint_restore') {
      return {
        ok: true,
        restoredTo: '/workspace/hello.txt',
      };
    }
    if (action.command === 'checkpoint_remove') {
      return {
        ok: true,
        id: action.args.id,
      };
    }
    if (action.command === 'resource_io_stat') {
      return {
        exists: true,
        kind: 'local-file',
        size: 5,
        mtimeMs: 1234,
        version: { mtimeMs: 1234, size: 5 },
      };
    }
    if (action.command === 'resource_io_read') {
      return {
        exists: true,
        content: action.args.encoding === 'base64' ? 'aGVsbG8=' : 'hello',
        encoding: action.args.encoding || 'utf-8',
        size: 5,
        version: { mtimeMs: 1234, size: 5 },
      };
    }
    if (action.command === 'resource_io_list') {
      return {
        items: [{ name: 'hello.txt', kind: 'file', size: 5 }],
      };
    }
    if (action.command === 'resource_io_search') {
      return {
        query: action.args.query,
        results: [{ name: 'hello.txt', path: 'hello.txt' }],
      };
    }
    if (action.command === 'resource_io_write') {
      return {
        ok: true,
        version: { mtimeMs: 1235, size: 11 },
      };
    }
    if (action.command === 'resource_io_write_expected_version') {
      if (action.args.expectedVersion === 'stale') {
        return {
          ok: false,
          conflict: true,
          currentVersion: { mtimeMs: 1235, size: 11 },
          safeMessage: 'Resource changed on disk',
        };
      }
      return {
        ok: true,
        version: { mtimeMs: 1236, size: 12 },
      };
    }
    if (action.command === 'resource_io_rename') {
      return { ok: true, from: action.args.from, to: action.args.to };
    }
    if (action.command === 'resource_io_move') {
      return { ok: true, from: action.args.from, to: action.args.to };
    }
    if (action.command === 'resource_io_trash') {
      return { ok: true, trashId: 'resource-trash-1' };
    }
    if (action.command === 'resource_get_metadata') {
      return {
        schemaVersion: 1,
        resourceId: action.args.resourceId,
        studioId: 'studio_local',
        type: 'file',
        source: 'session_file',
        fileId: 'sf_generated',
        displayName: 'generated.png',
        lifecycle: { status: 'available', missingAt: null },
        storage: { provider: 'session_file', localOnly: true },
        links: {
          self: '/api/resources/' + encodeURIComponent(action.args.resourceId),
          content: '/api/resources/' + encodeURIComponent(action.args.resourceId) + '/content',
        },
      };
    }
    if (action.command === 'resource_read_content') {
      return {
        exists: true,
        mime: 'image/png',
        size: 5,
        etag: '"resource-v1"',
        filename: 'generated.png',
        contentBase64: 'aGVsbG8=',
      };
    }
    if (action.command === 'transcript') return [];
    if (action.command === 'chat_partial') return null;
    throw new Error('unknown backend command: ' + action.command);
  };

  const workbenchCapabilities = await adapter.http('GET', '/api/capabilities');
  check('workbench capability registry opens after native host advertises commands',
    workbenchCapabilities?.capabilities?.fileWorkbench === true
    && workbenchCapabilities?.capabilities?.fileWorkbenchRead === true
    && workbenchCapabilities?.capabilities?.fileWorkbenchWrite === true
    && workbenchCapabilities?.capabilities?.fileWorkbenchSearch === true
    && workbenchCapabilities?.capabilities?.fileWorkbenchRename === true
    && workbenchCapabilities?.capabilities?.fileWorkbenchMove === true
    && workbenchCapabilities?.capabilities?.fileWorkbenchDelete === true
    && workbenchCapabilities?.capabilities?.fileWorkbenchUpload === true);  check('file history capability registry opens after native host advertises all history commands',
    workbenchCapabilities?.capabilities?.fileHistory === true
    && workbenchCapabilities?.capabilities?.fileHistoryList === true
    && workbenchCapabilities?.capabilities?.fileHistoryVersions === true
    && workbenchCapabilities?.capabilities?.fileHistorySnapshot === true
    && workbenchCapabilities?.capabilities?.fileHistoryRestore === true);
  check('ResourceIO capability registry opens after native host advertises all core commands',
    workbenchCapabilities?.capabilities?.resourceIO === true
    && workbenchCapabilities?.capabilities?.resourceIOStat === true
    && workbenchCapabilities?.capabilities?.resourceIORead === true
    && workbenchCapabilities?.capabilities?.resourceIOWrite === true
    && workbenchCapabilities?.capabilities?.resourceIORename === true
    && workbenchCapabilities?.capabilities?.resourceIOMove === true
    && workbenchCapabilities?.capabilities?.resourceIOTrash === true);
  check('generated resource preview capability opens after metadata/content commands are advertised',
    workbenchCapabilities?.capabilities?.generatedResourcePreview === true
    && workbenchCapabilities?.capabilities?.resourceMetadata === true
    && workbenchCapabilities?.capabilities?.resourceContent === true);
  check('checkpoint capability registry opens after native host advertises all checkpoint commands',
    workbenchCapabilities?.capabilities?.checkpoints === true
    && workbenchCapabilities?.capabilities?.checkpointList === true
    && workbenchCapabilities?.capabilities?.checkpointCreateUserEdit === true
    && workbenchCapabilities?.capabilities?.checkpointRestore === true
    && workbenchCapabilities?.capabilities?.checkpointRemove === true);



  const workbenchFiles = await adapter.http('GET', '/api/workbench/files?mountId=default&subdir=src');
  check('workbench list delegates to Studio native command',
    workbenchFiles?.rootId === 'default'
    && workbenchFiles?.subdir === 'src'
    && workbenchFiles?.files?.[0]?.name === 'hello.txt');

  const workbenchSearch = await adapter.http('GET', '/api/workbench/search?mountId=default&q=hello');
  check('workbench search delegates to Studio native command',
    workbenchSearch?.query === 'hello'
    && workbenchSearch?.results?.[0]?.relativePath === 'hello.txt');

  const workbenchContent = await adapter.http('GET', '/api/workbench/content?mountId=default&subdir=src&name=hello.txt');
  check('workbench content returns raw-body envelope',
    workbenchContent?.__httpStatus === 200
    && workbenchContent?.__httpBody === 'hello'
    && workbenchContent?.__httpBodyEncoding === 'utf8'
    && workbenchContent?.__httpHeaders?.ETag === '"v1"'
    && workbenchContent?.__httpHeaders?.['X-Hana-File-Version'] === 'v1'
    && workbenchContent?.__httpHeaders?.['Content-Length'] === '5');

  const workbenchHead = await adapter.http('HEAD', '/api/workbench/content?mountId=default&subdir=src&name=hello.txt');
  check('workbench HEAD preserves metadata without a body',
    workbenchHead?.__httpStatus === 200
    && workbenchHead?.__httpHeadOnly === true
    && workbenchHead?.__httpHeaders?.['Content-Length'] === '5');

  const workbenchWrite = await adapter.http('POST', '/api/workbench/actions', {
    action: 'writeText',
    mountId: 'default',
    subdir: 'src',
    name: 'hello.txt',
    content: 'hello world',
    expectedVersion: 'v1',
  });
  check('workbench writeText delegates to Studio native command',
    workbenchWrite?.ok === true && workbenchWrite?.version === 'v2');
  const originalWorkbenchHostAction = studio.hostAction;
  studio.hostAction = async (action) => action.command === 'workbench_write_file'
    ? { version: 'unconfirmed' } : originalWorkbenchHostAction(action);
  const unacknowledgedWorkbenchWrite = await adapter.http('POST', '/api/workbench/actions', {
    action: 'writeText', rootId: 'default', subdir: 'src', name: 'hello.txt',
    content: 'unconfirmed', expectedVersion: 'v1',
  });
  check('native workspace mutation without explicit ok is never acknowledged',
    unacknowledgedWorkbenchWrite?.ok === false);
  studio.hostAction = originalWorkbenchHostAction;
  const workbenchRename = await adapter.http('POST', '/api/workbench/actions', {
    action: 'rename',
    mountId: 'default',
    subdir: 'src',
    oldName: 'hello.txt',
    newName: 'renamed.txt',
    expectedVersion: 'v2',
  });
  check('workbench rename delegates to dedicated native command',
    workbenchRename?.ok === true && workbenchRename?.action === 'rename' && workbenchRename?.version === 'v3');

  const workbenchMove = await adapter.http('POST', '/api/workbench/actions', {
    action: 'move',
    mountId: 'default',
    subdir: 'src',
    name: 'renamed.txt',
    destSubdir: 'archive',
    expectedVersion: 'v3',
  });
  check('workbench move delegates to dedicated native command',
    workbenchMove?.ok === true && workbenchMove?.action === 'move' && workbenchMove?.subdir === 'archive');

  const workbenchDelete = await adapter.http('POST', '/api/workbench/actions', {
    action: 'safeDelete',
    mountId: 'default',
    subdir: 'archive',
    name: 'renamed.txt',
    expectedVersion: 'v4',
  });
  check('workbench safeDelete delegates to trash-capable native command',
    workbenchDelete?.ok === true && workbenchDelete?.action === 'safeDelete' && workbenchDelete?.trashId === 'trash-1');

  const workbenchUpload = await adapter.http('POST', '/api/workbench/upload', {
    mountId: 'default',
    subdir: 'src',
    files: [{
      name: 'uploaded.txt',
      contentBase64: 'aGVsbG8=',
      mimeType: 'text/plain',
    }],
  });
  check('workbench upload delegates to dedicated native command',
    workbenchUpload?.ok === true
    && workbenchUpload?.results?.[0]?.name === 'uploaded.txt'
    && workbenchUpload?.results?.[0]?.version === 'v6');
  const originalUploadHostAction = studio.hostAction;
  studio.hostAction = async (action) => action.command === 'workbench_upload_file'
    ? { name: action.args.name, version: 'unconfirmed' }
    : originalUploadHostAction(action);
  const unacknowledgedUpload = await adapter.http('POST', '/api/workbench/upload', {
    rootId: 'default', subdir: '', files: [{ name: 'missing-ack.txt', contentBase64: 'aGk=' }],
  });
  check('native upload missing an explicit ok is never reported as successful',
    unacknowledgedUpload?.ok === false && unacknowledgedUpload?.results?.[0]?.ok === false);
  studio.hostAction = originalUploadHostAction;
  const workbenchMobileRename = await adapter.http('POST', '/api/mobile/workbench/actions', {
    action: 'rename',
    mountId: 'default',
    subdir: 'src',
    oldName: 'uploaded.txt',
    newName: 'mobile-renamed.txt',
  });
  check('mobile workbench mutations share the native rename bridge',
    workbenchMobileRename?.ok === true && workbenchMobileRename?.action === 'rename');

  const historyFiles = await adapter.http('GET', '/api/file-history/files?agentId=workbench-session');
  check('file history file list delegates to native command',
    historyFiles?.files?.[0]?.relPath === 'src/hello.txt');

  const historyVersions = await adapter.http('GET', '/api/file-history/versions?agentId=workbench-session&relPath=src%2Fhello.txt');
  check('file history versions delegate to native command',
    historyVersions?.versions?.[0]?.id === 7);

  const historySnapshot = await adapter.http('GET', '/api/file-history/snapshot?agentId=workbench-session&id=7');
  check('file history snapshot delegates to native command',
    historySnapshot?.content === 'hello' && historySnapshot?.relPath === 'src/hello.txt');

  const historyRestore = await adapter.http('POST', '/api/file-history/restore', {
    agentId: 'workbench-session',
    snapshotId: 7,
  });
  check('file history restore delegates to native command',
    historyRestore?.ok === true && historyRestore?.relPath === 'src/hello.txt');
  const checkpointFiles = await adapter.http('GET', '/api/checkpoints');
  check('checkpoint list delegates to native command',
    checkpointFiles?.checkpoints?.[0]?.id === '1700000000_ab12');

  const checkpointCreate = await adapter.http('POST', '/api/checkpoints/user-edit', {
    filePath: '/workspace/hello.txt',
    reason: 'edit-start',
  });
  check('user-edit checkpoint creation delegates to native command',
    checkpointCreate?.ok === true
    && checkpointCreate?.checkpoint?.id === '1700000001_cd34'
    && checkpointCreate?.checkpoint?.path === '/workspace/hello.txt');

  const checkpointRestore = await adapter.http('POST', '/api/checkpoints/1700000000_ab12/restore');
  check('checkpoint restore delegates to native command',
    checkpointRestore?.ok === true && checkpointRestore?.restoredTo === '/workspace/hello.txt');

  const checkpointRemove = await adapter.http('DELETE', '/api/checkpoints/1700000000_ab12');
  check('checkpoint remove delegates to native command',
    checkpointRemove?.ok === true && checkpointRemove?.id === '1700000000_ab12');
  const priorCheckpointHost = studio.hostAction;
  studio.hostAction = async (action) => {
    if (action.command === 'checkpoint_restore') return { restoredTo: '/workspace/hello.txt' };
    if (action.command === 'checkpoint_remove') return { id: action.args.id };
    if (action.command === 'checkpoint_create_user_edit') return { checkpoint: { id: 'unconfirmed' } };
    return priorCheckpointHost(action);
  };
  const missingRestoreAck = await adapter.http('POST', '/api/checkpoints/1700000000_ab12/restore');
  const missingRemoveAck = await adapter.http('DELETE', '/api/checkpoints/1700000000_ab12');
  const missingCreateAck = await adapter.http('POST', '/api/checkpoints/user-edit', {
    filePath: '/workspace/hello.txt', reason: 'edit-start',
  });
  check('all checkpoint mutation routes require explicit native ok confirmation',
    missingRestoreAck?.ok === false && missingRemoveAck?.ok === false
    && missingCreateAck?.ok === false);
  studio.hostAction = priorCheckpointHost;

  const invalidCheckpointPath = await adapter.http('POST', '/api/checkpoints/user-edit', {
    filePath: 'relative.md',
    reason: 'edit-start',
  });
  check('native checkpoint create rejects relative paths before host invocation',
    invalidCheckpointPath?.ok === false
    && invalidCheckpointPath?.code === 'invalid_checkpoint_path'
    && invalidCheckpointPath?.__httpStatus === 400);

  const invalidCheckpointId = await adapter.http('DELETE', '/api/checkpoints/' + encodeURIComponent('../secret'));
  check('native checkpoint delete rejects traversal ids before host invocation',
    invalidCheckpointId?.ok === false
    && invalidCheckpointId?.code === 'invalid_checkpoint_id'
    && invalidCheckpointId?.__httpStatus === 400);


  const resourceStat = await adapter.http('POST', '/api/resource-io/stat', {
    resource: { kind: 'local-file', path: '/workspace/hello.txt' },
  });
  check('ResourceIO stat delegates to native command',
    resourceStat?.exists === true && resourceStat?.size === 5);

  const resourceRead = await adapter.http('POST', '/api/resource-io/read', {
    resource: { kind: 'local-file', path: '/workspace/hello.txt' },
    encoding: 'base64',
  });
  check('ResourceIO read preserves requested binary encoding',
    resourceRead?.content === 'aGVsbG8=' && resourceRead?.encoding === 'base64');

  const resourceWrite = await adapter.http('POST', '/api/resource-io/write', {
    resource: { kind: 'local-file', path: '/workspace/hello.txt' },
    content: 'hello world',
    reason: 'editor.save',
  });
  check('ResourceIO write delegates operation context without trusting principal input',
    resourceWrite?.ok === true && resourceWrite?.version?.size === 11);

  const resourceConflict = await adapter.http('POST', '/api/resource-io/write-expected-version', {
    resource: { kind: 'local-file', path: '/workspace/hello.txt' },
    content: 'stale',
    encoding: 'utf-8',
    expectedVersion: 'stale',
  });
  check('ResourceIO expected-version conflict becomes HTTP 409 envelope',
    resourceConflict?.ok === false
    && resourceConflict?.conflict === true
    && resourceConflict?.__httpStatus === 409
    && resourceConflict?.safeMessage === 'Resource changed on disk');

  const resourceRename = await adapter.http('POST', '/api/resource-io/rename', {
    from: { kind: 'local-file', path: '/workspace/hello.txt' },
    to: { kind: 'local-file', path: '/workspace/renamed.txt' },
  });
  check('ResourceIO rename delegates to native command',
    resourceRename?.ok === true && resourceRename?.to?.path === '/workspace/renamed.txt');

  const resourceMove = await adapter.http('POST', '/api/resource-io/move', {
    from: { kind: 'local-file', path: '/workspace/renamed.txt' },
    to: { kind: 'local-file', path: '/workspace/archive/renamed.txt' },
  });
  check('ResourceIO move delegates to native command',
    resourceMove?.ok === true && resourceMove?.to?.path === '/workspace/archive/renamed.txt');

  const resourceTrash = await adapter.http('POST', '/api/resource-io/trash', {
    resource: { kind: 'local-file', path: '/workspace/archive/renamed.txt' },
  });
  check('ResourceIO trash delegates to native recoverable delete',
    resourceTrash?.ok === true && resourceTrash?.trashId === 'resource-trash-1');

  const generatedMetadata = await adapter.http('GET', '/api/resources/res_sf_generated');
  check('generated resource metadata delegates to native command',
    generatedMetadata?.resourceId === 'res_sf_generated'
    && generatedMetadata?.displayName === 'generated.png');

  const generatedContent = await adapter.http('GET', '/api/resources/res_sf_generated/content');
  check('generated resource content becomes a binary bridge envelope',
    generatedContent?.__httpStatus === 200
    && generatedContent?.__httpBodyEncoding === 'base64'
    && generatedContent?.__httpBody === 'aGVsbG8='
    && generatedContent?.__httpHeaders?.['Content-Type'] === 'image/png'
    && generatedContent?.__httpHeaders?.ETag === '"resource-v1"');

  const generatedHead = await adapter.http('HEAD', '/api/resources/res_sf_generated/content');
  check('generated resource HEAD keeps metadata and removes body',
    generatedHead?.__httpHeadOnly === true
    && generatedHead?.__httpBody === ''
    && generatedHead?.__httpHeaders?.['Content-Length'] === '5');

  studio.hostAction = null;
}
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
  && lockedSessionPermission?.code === 'capability_unavailable');

const iframeBridgeSource = readFileSync(
  join(ROOT, 'ui/desktop/src/react/studio-backend/studio-backend-bridge.ts'),
  'utf8',
);
check('iframe bridge intercepts session permission mode requests',
  iframeBridgeSource.includes("pathname === '/api/session-permission-mode'"));
check('iframe bridge routes native memory toggles',
  iframeBridgeSource.includes("pathname === '/api/session-memory-enabled'"));
check('iframe bridge forwards approval list/decisions to the Studio native control',
  iframeBridgeSource.includes("pathname === '/api/tool-approvals'"));
check('iframe bridge intercepts appearance preference requests',
  iframeBridgeSource.includes("pathname === '/api/preferences/appearance'"));
check('iframe bridge intercepts sidebar UI preference requests',
  iframeBridgeSource.includes("pathname === '/api/preferences/sidebar-ui'"));
check('iframe bridge intercepts quick chat preference requests',
  iframeBridgeSource.includes("pathname === '/api/preferences/quick-chat'"));
check('iframe bridge intercepts notification preference requests',
  iframeBridgeSource.includes("pathname === '/api/preferences/notifications'"));
check('iframe bridge intercepts session search requests',
  iframeBridgeSource.includes("pathname === '/api/sessions/search'"));
check('iframe bridge intercepts session summary requests',
  iframeBridgeSource.includes("pathname === '/api/sessions/summary'"));
check('iframe bridge intercepts authorized-folder requests',
  iframeBridgeSource.includes("pathname === '/api/sessions/authorized-folders'"));check('iframe bridge decodes native binary resource responses',
  iframeBridgeSource.includes("envelope?.__httpBodyEncoding === 'base64'")
  && iframeBridgeSource.includes('decodeBase64Body'));
check('iframe bridge bypasses ticketed resource content requests',
  iframeBridgeSource.includes('ticketedResourceContent')
  && iframeBridgeSource.includes("new URLSearchParams(target.search).has('ticket')"));


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
        { id: 'agent-1', title: 'Hello', busy: false, live: true, messages: 2, turns: 1, status: 'idle', usage: null, provider: 'deepseek', model: 'deepseek-reasoner', cwd: '/tmp/project-a', workspaceMountId: 'mount-a', workspaceLabel: 'Project A' },
        { id: 'agent-2', title: 'Cold', busy: false, live: false, messages: 1, turns: 1, status: 'idle', usage: null },
      ]);
    }
    if (cmd === 'list_agents') return Promise.resolve([{ id: 'studio', title: 'Hanako', live: true, status: 'idle' }]);
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
    if (cmd === 'get_session_summary') {
      return Promise.resolve({
        hasSummary: true,
        summary: 'Conversation summary (fresh-compact):\n- durable summary',
        createdAt: 1780000000000,
        updatedAt: 1780000000000,
      });
    }
    if (cmd === 'get_session_folder_scope') {
      return Promise.resolve({
        ok: true,
        sessionId: args.agentId,
        cwd: '/tmp/studio',
        workspaceFolders: [],
        authorizedFolders: ['/tmp/shared'],
        sandboxFolders: ['/tmp/studio', '/tmp/shared'],
      });
    }
    if (cmd === 'patch_session_authorized_folders') {
      return Promise.resolve({
        ok: true,
        sessionId: args.agentId,
        cwd: '/tmp/studio',
        workspaceFolders: [],
        authorizedFolders: args.action === 'remove' ? [] : ['/tmp/shared'],
        sandboxFolders: args.action === 'remove' ? ['/tmp/studio'] : ['/tmp/studio', '/tmp/shared'],
      });
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
    if (cmd === 'set_llm_config') return Promise.resolve({ ok: true });
    return Promise.reject(new Error('unknown ' + cmd));
  },
};

check('api mode flips to tauri once invoke exists', api.mode() === 'tauri');
const summaryResponse = await adapter.http('GET', '/api/sessions/summary?path=' + encodeURIComponent('studio://agent-1'));
check('session summary reads the Studio durable compaction summary',
  summaryResponse?.hasSummary === true
  && summaryResponse?.summary.includes('durable summary')
  && typeof summaryResponse?.createdAt === 'string'
  && typeof summaryResponse?.updatedAt === 'string'
  && calls.some((c) => c.cmd === 'get_session_summary' && c.args.agentId === 'agent-1'));

const folderScope = await adapter.http('GET', '/api/sessions/authorized-folders?path=' + encodeURIComponent('studio://agent-1'));
check('authorized-folder GET reads the Studio persisted scope',
  folderScope?.ok === true
  && folderScope?.authorizedFolders?.[0] === '/tmp/shared'
  && folderScope?.sandboxFolders?.includes('/tmp/studio'));

const folderAdded = await adapter.http('PATCH', '/api/sessions/authorized-folders', {
  path: 'studio://agent-1',
  action: 'add',
  folder: '/tmp/shared',
});
check('authorized-folder PATCH add delegates to the native Studio command',
  folderAdded?.ok === true
  && folderAdded?.authorizedFolders?.[0] === '/tmp/shared'
  && calls.some((c) => c.cmd === 'patch_session_authorized_folders'
    && c.args.agentId === 'agent-1'
    && c.args.action === 'add'
    && c.args.folder === '/tmp/shared'));

const folderRemoved = await adapter.http('PATCH', '/api/sessions/authorized-folders', {
  path: 'studio://agent-1',
  action: 'remove',
  folder: '/tmp/shared',
});
check('authorized-folder PATCH remove delegates to the native Studio command',
  folderRemoved?.ok === true
  && folderRemoved?.authorizedFolders?.length === 0
  && calls.some((c) => c.cmd === 'patch_session_authorized_folders'
    && c.args.agentId === 'agent-1'
    && c.args.action === 'remove'));
check('pickProvider falls back to configured provider without studio_status', await api.pickProvider() === 'deepseek');
const configuredStatus = await api.status();
check('status falls back to configured provider and model without studio_status',
  configuredStatus.provider === 'deepseek'
  && configuredStatus.providers.includes('deepseek')
  && configuredStatus.model === 'deepseek-chat'
  && /get_llm_config/.test(configuredStatus.note || ''));
const globalModelPrefs = await adapter.http('GET', '/api/preferences/models');
check('global model preferences expose Studio current model as utility fallback',
  globalModelPrefs?.models?.utility?.provider === 'deepseek'
  && globalModelPrefs?.models?.utility?.id === 'deepseek-chat'
  && globalModelPrefs?.models?.utility_large === null
  && globalModelPrefs?.models?.vision_enabled === false);
const savedGlobalModelPrefs = await adapter.http('PUT', '/api/preferences/models', {
  models: {
    utility_large: { provider: 'mock', id: 'mock-1' },
    vision: { provider: 'mock', id: 'mock-vision' },
    vision_enabled: true,
  },
  search: { provider: 'brave' },
});
check('global model preferences persist local-only selections',
  savedGlobalModelPrefs?.models?.utility_large?.id === 'mock-1'
  && savedGlobalModelPrefs?.models?.vision?.id === 'mock-vision'
  && savedGlobalModelPrefs?.models?.vision_enabled === true
  && savedGlobalModelPrefs?.search?.provider === 'brave');
const refreshedGlobalModelPrefs = await adapter.http('GET', '/api/preferences/models');
check('global model preference selections survive refresh',
  refreshedGlobalModelPrefs?.models?.utility_large?.provider === 'mock'
  && refreshedGlobalModelPrefs?.models?.vision?.id === 'mock-vision'
  && refreshedGlobalModelPrefs?.search?.provider === 'brave');
const invalidGlobalModelPrefs = await adapter.http('PUT', '/api/preferences/models', {
  models: { vision_enabled: 'yes' },
});
check('global model preference validation rejects malformed writes',
  invalidGlobalModelPrefs?.ok === false && /vision_enabled/.test(invalidGlobalModelPrefs?.error || ''));
calls.length = 0;
const utilityModelWrite = await adapter.http('PUT', '/api/preferences/models', {
  models: { utility: { provider: 'deepseek', id: 'deepseek-reasoner' } },
});
check('utility model preference updates Studio current model',
  utilityModelWrite?.ok === true
  && utilityModelWrite?.models?.utility?.id === 'deepseek-reasoner'
  && calls.some((call) => call.cmd === 'set_llm_config'
    && call.args.patch.current.provider === 'deepseek'
    && call.args.patch.current.model === 'deepseek-reasoner'));
const utilityModelRefresh = await adapter.http('GET', '/api/preferences/models');
check('utility model preference reads back the Studio-synced model',
  utilityModelRefresh?.models?.utility?.id === 'deepseek-reasoner');
await adapter.http('PUT', '/api/preferences/models', {
  models: { utility: { provider: 'deepseek', id: 'deepseek-chat' } },
});
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
  const runtimeBaseline = await adapter.http('GET', '/api/runtime-state');
  const runtimeUnchanged = await adapter.http(
    'GET', '/api/runtime-state?since=' + encodeURIComponent(runtimeBaseline.signature),
  );
  check('runtime-state supports signature-based incremental no-change responses',
    runtimeUnchanged?.unchanged === true
    && runtimeUnchanged?.signature === runtimeBaseline.signature
    && !Array.isArray(runtimeUnchanged?.sessions));

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

const created = await adapter.http('POST', '/api/sessions/new-detached', { cwd: '/tmp/project-b', workspaceFolders: ['/tmp/shared'] });
const agentsResponse = await adapter.http('GET', '/api/agents');
check('agent list comes from the agent surface rather than duplicating sessions',
  Array.isArray(agentsResponse?.agents)
  && agentsResponse.agents.length === 1
  && agentsResponse.agents[0]?.id === 'studio'
  && agentsResponse.agents[0]?.isPrimary === true);
const agentConfig = await adapter.http('GET', '/api/agents/studio/config');
check('agent config reports the current Studio model and unsupported controls',
  agentConfig?.source === 'studio-global-readonly'
  && agentConfig?.chat?.agentId === 'studio'
  && agentConfig?.capabilities?.modelSwitch === true
  && agentConfig?.capabilities?.thinkingLevel === false
  && agentConfig?.capabilities?.permissionMode === false);
const providerModelEdit = await adapter.http('PUT', '/api/providers/mock/models/mock-1', {
  name: 'Mock Vision', context: 32768, maxOutput: 4096,
  image: true, reasoning: true, input: ['text', 'image'],
});
check('provider model metadata writes to the local Studio overlay',
  providerModelEdit?.ok === true && providerModelEdit?.model?.name === 'Mock Vision');
const providerConfigAfterEdit = await adapter.http('GET', '/api/config');
check('provider model metadata survives provider refresh',
  providerConfigAfterEdit?.providers?.mock?.models?.some((model) =>
    model && typeof model === 'object' && model.id === 'mock-1'
    && model.name === 'Mock Vision' && model.context === 32768 && model.image === true));
const discoveredAfterEdit = await adapter.http('GET', '/api/providers/mock/discovered-models');
check('discovered model projection includes persisted metadata',
  discoveredAfterEdit?.models?.some((model) => model.id === 'mock-1' && model.name === 'Mock Vision'));
const modelsAfterMetadata = await adapter.http('GET', '/api/models');
check('model listing carries persisted model metadata into the chat selector',
  modelsAfterMetadata?.models?.some((model) =>
    model.id === 'mock-1' && model.name === 'Mock Vision' && model.context === 32768 && model.image === true));
const visionAfterMetadata = await adapter.http('GET', '/api/models/auxiliary-vision');
check('auxiliary vision capability becomes available from persisted model metadata',
  visionAfterMetadata?.available === true
  && visionAfterMetadata.models?.some((model) => model.id === 'mock-1' && model.image === true));
check('create_agent uses mock/mock-1',
  created.sessionId === 'agent-new'
  && created.path === 'studio://agent-new'
  && calls.some((c) => c.cmd === 'create_agent'
    && c.args.provider === 'mock' && c.args.model === 'mock-1'));
check('new session forwards the selected workspace cwd to Studio create_agent',
  created.cwd === '/tmp/project-b'
  && calls.some((c) => c.cmd === 'create_agent' && c.args.cwd === '/tmp/project-b'));

const mappedWorkspaceProject = await adapter.http('POST', '/api/session-projects/projects', {
  name: 'mapped-workspace-project', workspacePath: '/tmp/mapped-workspace',
});
check('session projects persist workspace mappings',
  mappedWorkspaceProject?.project?.workspacePath === '/tmp/mapped-workspace');
calls.length = 0;
const mappedWorkspaceSession = await adapter.http('POST', '/api/sessions/new-detached', {
  projectId: mappedWorkspaceProject?.project?.id,
});
check('project workspace mapping supplies cwd when creating a session without an explicit cwd',
  mappedWorkspaceSession?.cwd === '/tmp/mapped-workspace'
  && calls.some((c) => c.cmd === 'create_agent' && c.args.cwd === '/tmp/mapped-workspace'));
const mappedWorkspaceOverride = await adapter.http('POST', '/api/sessions/new-detached', {
  projectId: mappedWorkspaceProject?.project?.id,
  cwd: '/tmp/explicit-workspace',
});
check('explicit cwd overrides the project workspace mapping',
  mappedWorkspaceOverride?.cwd === '/tmp/explicit-workspace'
  && calls.some((c) => c.cmd === 'create_agent' && c.args.cwd === '/tmp/explicit-workspace'));
const missingWorkspaceProjectSession = await adapter.http('POST', '/api/sessions/new-detached', {
  projectId: 'missing-project-id',
});
check('new session rejects an unknown project instead of creating an unassigned mapping',
  missingWorkspaceProjectSession?.ok === false && missingWorkspaceProjectSession?.error === 'project not found');
await adapter.http('DELETE', '/api/session-projects/projects/' + encodeURIComponent(mappedWorkspaceProject?.project?.id || ''));
check('session projection hydrates Studio workspace metadata',
  projectedLive.some((session) =>
    session.sessionId === 'agent-1'
    && session.cwd === '/tmp/project-a'
    && session.workspaceMountId === 'mount-a'
    && session.workspaceLabel === 'Project A'));

calls.length = 0;
const switched = await adapter.http('POST', '/api/sessions/switch', { path: 'studio://agent-2', sessionId: 'agent-2' });
const switchedWithMetadata = await adapter.http('POST', '/api/models/set', {
  provider: 'mock', modelId: 'mock-1',
});
check('model switch response includes persisted model metadata',
  switchedWithMetadata?.model?.id === 'mock-1'
  && switchedWithMetadata?.model?.name === 'Mock Vision'
  && switchedWithMetadata?.model?.image === true);
const providerModelDelete = await adapter.http('DELETE', '/api/providers/mock/models/mock-1');
check('provider model metadata can be explicitly cleared',
  providerModelDelete?.ok === true && !providerModelDelete?.model?.name);
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
    if (cmd === 'complete_session_todos') {
      return Promise.resolve([
        { content: 'read', status: 'completed' },
        { content: 'write', status: 'completed' },
      ]);
    }
    if (cmd === 'fresh_compact_session') {
      return Promise.resolve({ fresh: true, reason: 'manual', tokensBefore: null, tokensAfter: null });
    }
    if (cmd === 'continue_deleted_agent_session') {
      return Promise.resolve({ ok: true, path: 'studio://agent-continued', sessionId: 'agent-continued', agentId: 'agent-continued', compacted: true, compactionError: null });
    }
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

  const summaryUnsupported = await adapter.http('GET', '/api/sessions/summary?path=' + encodeURIComponent('studio://agent-1'));
  check('session summary fails closed when the native command is unavailable',
    summaryUnsupported?.hasSummary === false && summaryUnsupported?.code === 'summary_failed');
  const foldersUnsupported = await adapter.http('GET', '/api/sessions/authorized-folders?path=' + encodeURIComponent('studio://agent-1'));
  check('authorized folders fail closed when the native command is unavailable',
    foldersUnsupported?.ok === false && foldersUnsupported?.code === 'authorized_folders_failed');

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

// Cleanup must really dispose archived sessions older than the requested age;
// Studio-native compact/todo mutation routes must delegate to real host commands.
{
  await adapter.http('POST', '/api/sessions/archive', { sessionId: 'agent-2' });
  calls.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 2));
  const plan = await adapter.http('POST', '/api/sessions/cleanup', {
    maxAgeDays: 0.000000001, dryRun: true,
  });
  check('dry run returns authoritative exact archive candidate IDs without deleting',
    plan?.ok === true && plan.dryRun === true
    && plan.count === plan.sessionIds.length
    && plan.sessionIds.includes('agent-2')
    && !calls.some((c) => c.cmd === 'dispose_agent'));
  const changed = await adapter.http('POST', '/api/sessions/cleanup', {
    maxAgeDays: 0.000000001, expectedSessionIds: ['unexpected-session'],
  });
  check('changed preview fails closed without invoking disposal',
    changed?.ok === false && changed.code === 'preview_changed'
    && !calls.some((c) => c.cmd === 'dispose_agent'));
  const malformed = await adapter.http('POST', '/api/sessions/cleanup', {
    maxAgeDays: 0.000000001, expectedSessionIds: ['agent-2', 'agent-2'],
  });
  check('duplicate confirmation snapshot is rejected before cleanup',
    malformed?.ok === false && malformed.code === 'invalid_preview'
    && !calls.some((c) => c.cmd === 'dispose_agent'));
  const invalidAge = await adapter.http('POST', '/api/sessions/cleanup', {
    maxAgeDays: 0, dryRun: true,
  });
  check('cleanup refuses zero retention even as a dry run', invalidAge?.ok === false);
  const cleaned = await adapter.http('POST', '/api/sessions/cleanup', {
    maxAgeDays: 0.000000001, expectedSessionIds: plan.sessionIds,
  });
  check('archived cleanup permanently disposes expired sessions',
    cleaned?.deleted >= 1
    && cleaned?.failed === 0
    && calls.some((c) => c.cmd === 'dispose_agent' && c.args.agentId === 'agent-2'));
  const archivedAfterCleanup = await adapter.http('GET', '/api/sessions/archived');
  check('archived cleanup removes disposed metadata',
    !archivedAfterCleanup.some((row) => row.sessionId === 'agent-2'));

  const compactResult = await adapter.http('POST', '/api/sessions/fresh-compact', { path: 'studio://agent-2' });
  check('fresh compact uses the Studio persisted compaction command',
    compactResult?.ok === true
    && compactResult?.fresh === true
    && calls.some((c) => c.cmd === 'fresh_compact_session' && c.args.agentId === 'agent-2'));

  const todosCompleted = await adapter.http('POST', '/api/sessions/todos/complete', { path: 'studio://agent-2' });
  check('todo completion uses the Studio persisted mutation command',
    todosCompleted?.ok === true
    && todosCompleted?.todos?.length === 0
    && todosCompleted?.completed?.length === 2
    && calls.some((c) => c.cmd === 'complete_session_todos' && c.args.agentId === 'agent-2'));

  const deletedContinuation = await adapter.http('POST', '/api/sessions/continue-deleted-agent', { path: 'studio://agent-2' });
  check('deleted-agent continuation uses the Studio native command',
    deletedContinuation?.ok === true
    && deletedContinuation?.path === 'studio://agent-continued'
    && deletedContinuation?.compacted === true
    && calls.some((c) => c.cmd === 'continue_deleted_agent_session' && c.args.agentId === 'agent-2'));
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


// Stage A bridge contract: host controls are never synthesized from local prefs.
// A native mutation must ACK the requested agent, field, and revised config.
{
  const originalHostAction = studio.hostAction;
  const calls = [];
  let badAck = false;
  let denied = false;
  studio.hostAction = async (action) => {
    calls.push(action);
    if (denied) throw new Error('runtime refused control change');
    const { command, args = {} } = action;
    if (command === 'list_agents') return [
      { id: 'a1', title: 'First native Agent', live: true },
      { id: 'a2', title: 'Second native Agent', live: true },
    ];
    if (command === 'get_agent_control_capabilities') return { ok: true, capabilities: {
      thinkingLevel: true, permissionMode: true, memoryToggle: true,
      primaryAgentSwitch: true, agentConfigWrite: true,
    } };
    if (command === 'list_shared_memory') return { ok: true, agentId: args.agentId,
      facts: [{ id: 'memory-101-1', sourceAgent: 'a1', text: 'Use Chinese' }],
    };
    if (command === 'delete_shared_memory') return { ok: true, agentId: badAck ? 'wrong' : args.agentId,
      id: args.factId, deleted: true,
    };
    if (command === 'pending_tool_approvals') return { ok: true, agentId: args.agentId,
      approvals: [{ id: 'approval-42', agentId: args.agentId, callId: 'c1',
        toolName: 'write_file', arguments: { path: 'doc.txt' } }],
    };
    if (command === 'decide_tool_approval') return {
      ok: true, agentId: badAck ? 'other-agent' : args.agentId,
      id: args.approvalId, approved: args.approved,
    };
    if (command === 'get_session_runtime_controls') return {
      ok: true, agentId: args.agentId, level: 'medium', mode: 'ask', enabled: false,
    };
    if (command === 'set_session_thinking_level') return {
      ok: true, agentId: badAck ? 'another-agent' : args.agentId, level: args.level,
    };
    if (command === 'set_session_permission_mode') return {
      ok: true, agentId: args.agentId, mode: badAck ? 'ask' : args.mode,
    };
    if (command === 'set_session_memory_enabled') return {
      ok: true, agentId: args.agentId, enabled: badAck ? !args.enabled : args.enabled,
    };
    if (command === 'get_primary_agent') return { ok: true, agentId: 'a1' };
    if (command === 'switch_primary_agent') return {
      ok: true, agentId: badAck ? 'a2' : args.agentId,
    };
    if (command === 'get_agent_config') return {
      ok: true, agentId: args.agentId, revision: 'r1', config: { model: 'mock-1' },
    };
    if (command === 'patch_agent_config') return {
      ok: true, agentId: args.agentId, revision: badAck ? args.revision : 'r2',
      config: { ...args.patch },
    };
    throw new Error('unknown ' + command);
  };
  const advertised = await adapter.http('GET', '/api/capabilities');
  check('Stage A capabilities unlock only after authenticated host evidence',
    advertised.capabilities.thinkingLevel === true
    && advertised.capabilities.permissionMode === true
    && advertised.capabilities.memoryToggle === true
    && advertised.capabilities.primaryAgentSwitch === true
    && advertised.capabilities.agentConfigWrite === true);
  const sharedFacts = await adapter.http('GET', '/api/shared-memory?agentId=native-stage-a');
  const sharedDeletion = await adapter.http('POST', '/api/shared-memory/remove', {
    agentId: 'native-stage-a', factId: 'memory-101-1',
  });
  const invalidFact = await adapter.http('POST', '/api/shared-memory/remove', {
    agentId: 'native-stage-a', factId: '../memory',
  });
  check('shared memory list/removal validates IDs and exact native acknowledgment',
    sharedFacts?.ok === true && sharedFacts.facts[0].text === 'Use Chinese'
    && sharedDeletion?.ok === true && invalidFact?.code === 'invalid_memory');
  const nativeApprovals = await adapter.http('GET', '/api/tool-approvals?agentId=native-stage-a');
  const nativeDecision = await adapter.http('POST', '/api/tool-approvals/decision', {
    agentId: 'native-stage-a', approvalId: 'approval-42', approved: false,
  });
  check('pending native tool calls and exact deny decision use authorized commands',
    nativeApprovals?.ok === true && nativeApprovals.approvals.length === 1
    && nativeApprovals.approvals[0].arguments.path === 'doc.txt'
    && nativeDecision?.approved === false && nativeDecision?.ok === true);
  const malformedApproval = await adapter.http('POST', '/api/tool-approvals/decision', {
    agentId: 'native-stage-a', approvalId: '../other', approved: true,
  });
  check('malformed native approval identifiers are rejected before native dispatch',
    malformedApproval?.code === 'invalid_approval');
  const sessionId = 'native-stage-a';
  const getControls = await adapter.http('GET', '/api/session-thinking-level?sessionId=' + sessionId);
  check('native session control get verifies identity and runtime values',
    getControls?.ok === true && getControls.agentId === sessionId
    && getControls.level === 'medium' && getControls.enabled === false);
  const thinking = await adapter.http('POST', '/api/session-thinking-level', { sessionId, level: 'high' });
  const permission = await adapter.http('POST', '/api/session-permission-mode', { sessionId, mode: 'read-only' });
  const memory = await adapter.http('POST', '/api/session-memory-enabled', { sessionId, enabled: true });
  const thinkingFromPath = await adapter.http('GET',
    '/api/session-thinking-level?sessionPath=studio%3A%2F%2Fnative-stage-a');
  check('native thinking, permission and memory writes require exact acknowledged values',
    thinking?.ok === true && permission?.ok === true && memory?.ok === true
    && thinkingFromPath?.thinkingLevel === 'medium'
    && calls.some((item) => item.command === 'set_session_memory_enabled' && item.args.agentId === sessionId));
  const primary = await adapter.http('GET', '/api/agents/primary');
  const switched = await adapter.http('POST', '/api/agents/switch', { id: 'a2' });
  const agentList = await adapter.http('GET', '/api/agents');
  check('native primary agent queries and switches are confirmed by target ID',
    primary?.agentId === 'a1' && primary?.id === 'a1'
    && switched?.agentId === 'a2' && switched?.agent?.name === 'Second native Agent'
    && switched.ok === true && agentList.agents.some((row) => row.id === 'a1' && row.isPrimary));
  const config = await adapter.http('GET', '/api/agents/a2/config');
  const patch = await adapter.http('PATCH', '/api/agents/a2/config', {
    revision: 'r1', patch: { model: 'mock-2', memoryEnabled: false },
  });
  const legacyPut = await adapter.http('PUT', '/api/agents/a2/config', {
    chat: { provider: 'mock', model: 'mock-3' }, memory: { enabled: true },
  });
  check('per-agent config requires durable revision and fresh mutation readback',
    config?.ok === true && config.revision === 'r1'
    && patch?.ok === true && patch.revision === 'r2' && patch.config.memoryEnabled === false
    && legacyPut?.ok === true
    && calls.some((call) => call.command === 'patch_agent_config'
      && call.args.patch.model === 'mock-3' && call.args.revision === 'r1'));
  const invalidMode = await adapter.http('POST', '/api/session-permission-mode', {
    sessionId, mode: 'admin',
  });
  const invalidPatch = await adapter.http('PATCH', '/api/agents/a2/config', {
    revision: 'r1', patch: { systemPrompt: 'unsafe unsupported field' },
  });
  const unsafeLegacyPut = await adapter.http('PUT', '/api/agents/a2/config', { memory: { dream: { enabled: true } } });
  const unsafeModelPut = await adapter.http('PUT', '/api/agents/a2/config', {
    models: { chat: { model: 'mock-1' }, utility: { model: 'ignored-if-fake' } },
  });
  check('invalid permission and arbitrary config keys are rejected before host dispatch',
    invalidMode?.code === 'invalid_control' && invalidPatch?.code === 'invalid_config'
    && unsafeLegacyPut?.code === 'invalid_config'
    && unsafeModelPut?.code === 'invalid_config');
  badAck = true;
  const wrongSharedDeletion = await adapter.http('POST', '/api/shared-memory/remove', {
    agentId: 'native-stage-a', factId: 'memory-101-1',
  });
  check('shared memory cannot accept a cross-Agent native success echo',
    wrongSharedDeletion?.code === 'invalid_native_ack');
  const wrongApproval = await adapter.http('POST', '/api/tool-approvals/decision', {
    agentId: 'native-stage-a', approvalId: 'approval-42', approved: true,
  });
  check('cross-Agent native approval acknowledgment never claims success',
    wrongApproval?.code === 'invalid_native_ack' && wrongApproval?.ok === false);
  const wrongThinking = await adapter.http('POST', '/api/session-thinking-level', { sessionId, level: 'high' });
  const wrongMemory = await adapter.http('POST', '/api/session-memory-enabled', { sessionId, enabled: false });
  const wrongPrimary = await adapter.http('POST', '/api/agents/switch', { agentId: 'a1' });
  const stalePatch = await adapter.http('PATCH', '/api/agents/a2/config', {
    revision: 'r1', patch: { memoryEnabled: true },
  });
  check('misdirected and stale native ACKs cannot masquerade as control changes',
    [wrongThinking, wrongMemory, wrongPrimary, stalePatch].every((item) =>
      item?.ok === false && item.code === 'invalid_native_ack'));
  denied = true;
  const deniedPermission = await adapter.http('POST', '/api/session-permission-mode', {
    sessionId, mode: 'auto',
  });
  check('native permission enforcement rejection is surfaced, not downgraded to local state',
    deniedPermission?.ok === false && deniedPermission?.code === 'native_control_failed');
  studio.hostAction = originalHostAction;
  const absent = await adapter.http('GET', '/api/capabilities');
  check('Stage A controls stay disabled when the native host is absent',
    absent.capabilities.thinkingLevel === false
    && absent.capabilities.permissionMode === false
    && absent.capabilities.memoryToggle === false
    && absent.capabilities.primaryAgentSwitch === false
    && absent.capabilities.agentConfigWrite === false);
}

// Native Phase B vertical slices (separate from legacy browser-only tests).
{
  const original = {
    projectAvailable: api.projectCatalogAvailable,
    getProject: api.getProjectCatalog,
    putProject: api.putProjectCatalog,
    schedulerAvailable: api.automationSchedulerAvailable,
    jobs: api.getAutomationJobs,
    mutate: api.mutateAutomationJob,
    run: api.runAutomationJob,
    filesAvailable: api.sessionAttachmentsAvailable,
    list: api.listSessionAttachments,
    read: api.readSessionAttachment,
    delete: api.deleteSessionAttachment,
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  let nativeCatalog = { revision: 'r0', catalog: { projects: [], folders: [] }, assignments: {} };
  let failCas = false;
  api.projectCatalogAvailable = () => true;
  api.getProjectCatalog = async () => ({ ok: true, ...clone(nativeCatalog) });
  api.putProjectCatalog = async (revision, catalog, assignments) => {
    if (failCas || revision !== nativeCatalog.revision) throw new Error('project revision conflict');
    nativeCatalog = { revision: 'r' + (Number(revision.slice(1)) + 1),
      catalog: clone(catalog), assignments: clone(assignments) };
    return { ok: true, ...clone(nativeCatalog) };
  };
  const folder = await adapter.http('POST', '/api/session-projects/folders', { name: 'Native projects' });
  const project = await adapter.http('POST', '/api/session-projects/projects', {
    name: 'Native build', folderId: folder.folder.id, workspacePath: '/tmp/native-project',
  });
  const assignment = await adapter.http('POST', '/api/session-projects/session-assignment', {
    sessionPath: 'studio://agent-1', projectId: project.project.id,
  });
  const listing = await adapter.http('GET', '/api/session-projects');
  check('native catalog handles folder/project/session assignment and CAS with no local persistence',
    folder?.ok === true && project?.ok === true && assignment?.ok === true
    && listing.catalog.projects.some((row) => row.id === project.project.id)
    && nativeCatalog.assignments['studio://agent-1'] === project.project.id
    && nativeCatalog.revision === 'r3');
  failCas = true;
  const failedProject = await adapter.http('POST', '/api/session-projects/projects', { name: 'Bad overlap' });
  check('native project conflict fails closed instead of acknowledging optimistic local data',
    failedProject?.ok === false && nativeCatalog.revision === 'r3');
  failCas = false;
  const listingAfterConflict = await adapter.http('GET', '/api/session-projects');
  check('project conflict does not leak failed optimistic data into native reads',
    !listingAfterConflict.catalog.projects.some((row) => row.name === 'Bad overlap'));

  // Phase C migration: preview, confirm, CAS and preserve old browser copy.
  const priorStorage = global.localStorage;
  const browserData = new Map();
  global.localStorage = {
    getItem(key) { return browserData.has(key) ? browserData.get(key) : null; },
    setItem(key, value) { browserData.set(key, String(value)); },
    removeItem(key) { browserData.delete(key); },
  };
  browserData.set('openhanako.sessionProjectCatalog.v1', JSON.stringify({
    folders: [{ id: 'f-legacy', name: 'Old folder', order: 0 }],
    projects: [{ id: 'p-legacy', name: 'Old project', folderId: 'f-legacy',
      workspacePath: '/tmp/legacy', order: 0 }],
  }));
  browserData.set('openhanako.sessionProjectAssignments.v1', JSON.stringify({
    'studio://legacy': 'p-legacy', 'studio://invalid': 'absent-project',
  }));
  const collisionPreview = await adapter.http('GET', '/api/session-projects/native-migration');
  check('migration preview blocks overwriting a nonempty native project catalog',
    collisionPreview?.ok === true && collisionPreview?.canImport === false
      && collisionPreview?.projects === 1 && collisionPreview?.assignments === 1);
  nativeCatalog = { revision: 'r9', catalog: { projects: [], folders: [] }, assignments: {} };
  const preview = await adapter.http('GET', '/api/session-projects/native-migration');
  const prematureImport = await adapter.http('POST', '/api/session-projects/native-migration', {
    confirm: 'import-local-projects', sourceSignature: 'stale', nativeRevision: preview.nativeRevision,
  });
  check('migration requires a matching preview and explicit user confirmation',
    preview?.canImport === true && preview.sourceSignature?.startsWith('legacy-')
    && prematureImport?.code === 'migration_requires_confirmation');
  const imported = await adapter.http('POST', '/api/session-projects/native-migration', {
    confirm: 'import-local-projects', sourceSignature: preview.sourceSignature,
    nativeRevision: preview.nativeRevision,
  });
  check('explicit local to native migration preserves folders, assignments and source backup',
    imported?.ok === true && imported?.imported === true && imported.sourcePreserved === true
    && nativeCatalog.catalog.projects[0]?.name === 'Old project'
    && nativeCatalog.assignments['studio://legacy'] === 'p-legacy'
    && !nativeCatalog.assignments['studio://invalid']
    && browserData.get('openhanako.sessionProjectCatalog.v1')?.includes('Old project'));
  const secondImport = await adapter.http('GET', '/api/session-projects/native-migration');
  check('a completed migration cannot be silently imported twice',
    secondImport?.canImport === false);
  if (priorStorage === undefined) delete global.localStorage;
  else global.localStorage = priorStorage;
  nativeCatalog = { revision: 'r3', catalog: clone(listing.catalog),
    assignments: { 'studio://agent-1': project.project.id } };

  let job = { id: 'automation-native-1', type: 'every', schedule: 60000, enabled: false,
    label: 'Native check', prompt: 'Check', nextRunAt: null };
  let failedScheduler = false;
  api.automationSchedulerAvailable = () => true;
  api.getAutomationJobs = async () => ({ ok: true, schedulerAvailable: true, jobs: [clone(job)] });
  api.mutateAutomationJob = async (payload) => {
    if (failedScheduler) throw new Error('cannot save scheduler');
    if (payload.action === 'toggle') job.enabled = !job.enabled;
    if (payload.action === 'update') job = { ...job, ...payload };
    return { ok: true, job: clone(job) };
  };
  api.runAutomationJob = async (id) => ({ ok: true, status: 'dispatched', jobId: id, agentId: 'agent-1' });
  const schedulerList = await adapter.http('GET', '/api/desk/cron');
  const enabled = await adapter.http('POST', '/api/desk/cron', { action: 'toggle', id: job.id });
  const ran = await adapter.http('POST', '/api/desk/cron', { action: 'run', id: job.id });
  check('automation scheduler routes native enablement and run-now acknowledgments',
    schedulerList?.schedulerAvailable === true && schedulerList.jobs[0].enabled === false
    && enabled.job.enabled === true && ran.status === 'dispatched');
  failedScheduler = true;
  const failedJob = await adapter.http('POST', '/api/desk/cron', { action: 'toggle', id: job.id });
  check('scheduler cannot display enabled on a failed native mutation',
    failedJob?.ok === false && job.enabled === true);

  const fileId = 'studio-file-abcd-1234';
  api.sessionAttachmentsAvailable = () => true;
  let attachmentRemoved = false;
  api.listSessionAttachments = async (agentId) => ({ ok: true, sessionId: agentId,
    files: attachmentRemoved ? [] : [{ sessionId: agentId, id: fileId, name: 'notes.txt', size: 7 }],
  });
  api.readSessionAttachment = async (agentId, id) => ({ ok: true, sessionId: agentId,
    id, name: 'notes.txt', size: 7, base64: 'dGVzdGluZw==' });
  api.deleteSessionAttachment = async (agentId, id) => {
    attachmentRemoved = true;
    return { ok: true, sessionId: agentId, id, deleted: true };
  };
  const listed = await adapter.http('GET', '/api/session-attachments?sessionId=agent-1');
  const attachment = await adapter.http('GET', '/api/session-attachments/content?sessionId=agent-1&fileId=' + fileId);
  const removed = await adapter.http('POST', '/api/session-attachments/remove', { sessionId: 'agent-1', fileId });
  const badAttachment = await adapter.http('GET', '/api/session-attachments/content?sessionId=agent-1&fileId=..%2Fsecret');
  check('session attachment lifecycle requires native IDs and matching ack',
    listed?.files?.length === 1 && attachment?.base64 === 'dGVzdGluZw=='
    && removed?.deleted === true && badAttachment?.code === 'invalid_file');
  api.projectCatalogAvailable = original.projectAvailable;
  api.getProjectCatalog = original.getProject;
  api.putProjectCatalog = original.putProject;
  api.automationSchedulerAvailable = original.schedulerAvailable;
  api.getAutomationJobs = original.jobs;
  api.mutateAutomationJob = original.mutate;
  api.runAutomationJob = original.run;
  api.sessionAttachmentsAvailable = original.filesAvailable;
  api.listSessionAttachments = original.list;
  api.readSessionAttachment = original.read;
  api.deleteSessionAttachment = original.delete;
}

detach();
check('detach removes the message listener', messageHandlers.length === 0);

if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('studio bridge: ok');
