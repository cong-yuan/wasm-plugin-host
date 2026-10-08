export interface SidebarUiProjectViewPrefs {
  collapsedProjectIds: string[];
  collapsedFolderIds: string[];
  showAllProjectIds: string[];
}

export type SidebarSessionListRowMode = "two-line" | "single-line";

export interface SidebarUiSessionListPrefs {
  rowMode: SidebarSessionListRowMode;
}

export interface SidebarUiShellPrefs {
  jianOpen: boolean;
}

export interface SidebarUiPrefs {
  projectView: SidebarUiProjectViewPrefs;
  sessionList: SidebarUiSessionListPrefs;
  shell: SidebarUiShellPrefs;
}

const DEFAULT_JIAN_OPEN = true;

const MAX_IDS = 256;
const MAX_ID_LENGTH = 240;
const DEFAULT_SESSION_LIST_ROW_MODE: SidebarSessionListRowMode = "two-line";

function cleanId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return "";
  return trimmed;
}

function uniqueIds(values: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(values) ? values : []) {
    const id = cleanId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

function normalizeRowMode(value: unknown): SidebarSessionListRowMode {
  return value === "single-line" ? "single-line" : DEFAULT_SESSION_LIST_ROW_MODE;
}

export type SidebarUiPrefsPatch = {
  projectView?: Partial<SidebarUiProjectViewPrefs>;
  sessionList?: Partial<SidebarUiSessionListPrefs>;
  shell?: Partial<SidebarUiShellPrefs>;
};

export function normalizeSidebarUiPrefs(raw: unknown = {}): SidebarUiPrefs {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const projectView = source.projectView && typeof source.projectView === "object" && !Array.isArray(source.projectView)
    ? (source.projectView as Record<string, unknown>)
    : {};
  const sessionList = source.sessionList && typeof source.sessionList === "object" && !Array.isArray(source.sessionList)
    ? (source.sessionList as Record<string, unknown>)
    : {};
  const shell = source.shell && typeof source.shell === "object" && !Array.isArray(source.shell)
    ? (source.shell as Record<string, unknown>)
    : {};
  return {
    projectView: {
      collapsedProjectIds: uniqueIds(projectView.collapsedProjectIds),
      collapsedFolderIds: uniqueIds(projectView.collapsedFolderIds),
      showAllProjectIds: uniqueIds(projectView.showAllProjectIds),
    },
    sessionList: {
      rowMode: normalizeRowMode(sessionList.rowMode),
    },
    shell: {
      jianOpen: typeof shell.jianOpen === "boolean" ? shell.jianOpen : DEFAULT_JIAN_OPEN,
    },
  };
}

export function normalizeSidebarUiPrefsPatch(raw: unknown = {}): SidebarUiPrefsPatch {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const patch: SidebarUiPrefsPatch = {};
  const projectView = source.projectView && typeof source.projectView === "object" && !Array.isArray(source.projectView)
    ? (source.projectView as Record<string, unknown>)
    : null;
  if (projectView) {
    const nextProjectView: Partial<SidebarUiProjectViewPrefs> = {};
    for (const key of ["collapsedProjectIds", "collapsedFolderIds", "showAllProjectIds"] as const) {
      if (Object.prototype.hasOwnProperty.call(projectView, key)) {
        nextProjectView[key] = uniqueIds(projectView[key]);
      }
    }
    if (Object.keys(nextProjectView).length > 0) {
      patch.projectView = nextProjectView;
    }
  }

  const sessionList = source.sessionList && typeof source.sessionList === "object" && !Array.isArray(source.sessionList)
    ? (source.sessionList as Record<string, unknown>)
    : null;
  if (sessionList && Object.prototype.hasOwnProperty.call(sessionList, "rowMode")) {
    const rowMode = sessionList.rowMode === "single-line" || sessionList.rowMode === "two-line"
      ? sessionList.rowMode
      : null;
    if (rowMode) {
      patch.sessionList = { rowMode };
    }
  }

  const shell = source.shell && typeof source.shell === "object" && !Array.isArray(source.shell)
    ? (source.shell as Record<string, unknown>)
    : null;
  if (shell && typeof shell.jianOpen === "boolean") {
    patch.shell = { jianOpen: shell.jianOpen };
  }

  return patch;
}

export function mergeSidebarUiPrefs(current: unknown = {}, partial: unknown = {}): SidebarUiPrefs {
  const base = normalizeSidebarUiPrefs(current);
  const patch = partial && typeof partial === "object" && !Array.isArray(partial) ? (partial as Record<string, unknown>) : {};
  const patchProjectView = patch.projectView && typeof patch.projectView === "object" && !Array.isArray(patch.projectView)
    ? (patch.projectView as Record<string, unknown>)
    : {};
  const nextProjectView: Record<string, string[]> = { ...base.projectView };
  for (const key of ["collapsedProjectIds", "collapsedFolderIds", "showAllProjectIds"] as const) {
    if (Object.prototype.hasOwnProperty.call(patchProjectView, key)) {
      nextProjectView[key] = uniqueIds(patchProjectView[key]);
    }
  }
  const patchSessionList = patch.sessionList && typeof patch.sessionList === "object" && !Array.isArray(patch.sessionList)
    ? (patch.sessionList as Record<string, unknown>)
    : {};
  const nextSessionList: SidebarUiSessionListPrefs = { ...base.sessionList };
  if (Object.prototype.hasOwnProperty.call(patchSessionList, "rowMode")) {
    if (patchSessionList.rowMode === "single-line" || patchSessionList.rowMode === "two-line") {
      nextSessionList.rowMode = patchSessionList.rowMode;
    }
  }
  const patchShell = patch.shell && typeof patch.shell === "object" && !Array.isArray(patch.shell)
    ? (patch.shell as Record<string, unknown>)
    : {};
  const nextShell: SidebarUiShellPrefs = { ...base.shell };
  if (Object.prototype.hasOwnProperty.call(patchShell, "jianOpen") && typeof patchShell.jianOpen === "boolean") {
    nextShell.jianOpen = patchShell.jianOpen;
  }
  return normalizeSidebarUiPrefs({
    projectView: nextProjectView,
    sessionList: nextSessionList,
    shell: nextShell,
  });
}
