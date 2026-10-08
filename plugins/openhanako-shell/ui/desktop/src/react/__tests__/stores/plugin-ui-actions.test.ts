import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state, hanaFetchMock } = vi.hoisted(() => {
  const state = {
    pluginPages: [] as any[],
    pluginWidgets: [] as any[],
    pluginUiHostCapabilities: {} as Record<string, string[]>,
    hiddenWidgets: [] as string[],
    hiddenPluginTabs: [] as string[],
    tabOrder: [] as string[],
    currentTab: 'chat',
    jianView: 'desk',
    jianOpen: false,
    setPluginPages: vi.fn((pages: any[]) => { state.pluginPages = pages; }),
    setPluginWidgets: vi.fn((widgets: any[]) => { state.pluginWidgets = widgets; }),
    setPluginUiHostCapabilities: vi.fn((grants: Record<string, string[]>) => { state.pluginUiHostCapabilities = grants; }),
    setHiddenWidgets: vi.fn((ids: string[]) => { state.hiddenWidgets = ids; }),
    setHiddenPluginTabs: vi.fn((ids: string[]) => { state.hiddenPluginTabs = ids; }),
    setTabOrder: vi.fn((order: string[]) => { state.tabOrder = order; }),
    setCurrentTab: vi.fn((tab: string) => { state.currentTab = tab; }),
    setJianView: vi.fn((view: string) => { state.jianView = view; }),
    setJianOpen: vi.fn((open: boolean) => { state.jianOpen = open; }),
  };

  return {
    state,
    hanaFetchMock: vi.fn(),
  };
});

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => state,
  },
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: hanaFetchMock,
}));

import {
  hideWidget,
  refreshPluginUI,
  reorderTabs,
  showWidget,
} from '../../stores/plugin-ui-actions';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flushQueue(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('plugin-ui-actions', () => {
  beforeEach(() => {
    state.pluginPages = [];
    state.pluginWidgets = [];
    state.pluginUiHostCapabilities = {};
    state.hiddenWidgets = [];
    state.hiddenPluginTabs = [];
    state.tabOrder = [];
    state.currentTab = 'chat';
    state.jianView = 'desk';
    state.jianOpen = false;
    vi.clearAllMocks();
    hanaFetchMock.mockReset();
  });

  it('does not let a slower plugin catalog refresh overwrite a newer refresh', async () => {
    let resolveFirstPages!: (value: Response) => void;
    const firstPages = new Promise<Response>((resolve) => { resolveFirstPages = resolve; });

    let pagesCalls = 0;
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/plugins/pages') {
        pagesCalls += 1;
        if (pagesCalls === 1) return firstPages;
        return response([{ pluginId: 'new', title: 'New', icon: null, routeUrl: '/api/plugins/new/page', hostCapabilities: [] }]);
      }
      if (url === '/api/plugins/widgets') {
        return response([{ pluginId: 'widget', title: 'Widget', icon: null, routeUrl: '/api/plugins/widget/widget', hostCapabilities: [] }]);
      }
      if (url === '/api/plugins/ui-host-capabilities') {
        return response([]);
      }
      return response({ hiddenWidgets: [], hiddenTabs: [], tabOrder: [] });
    });

    const stale = refreshPluginUI();
    const fresh = refreshPluginUI();
    await fresh;

    expect(state.pluginPages).toEqual([
      expect.objectContaining({ pluginId: 'new' }),
    ]);

    resolveFirstPages(response([{ pluginId: 'old', title: 'Old', icon: null, routeUrl: '/api/plugins/old/page', hostCapabilities: [] }]));
    await stale;

    expect(state.pluginPages).toEqual([
      expect.objectContaining({ pluginId: 'new' }),
    ]);
  });

  it('serializes plugin UI preference writes so rapid hide/show changes cannot reorder requests', async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    let preferenceCalls = 0;

    hanaFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url !== '/api/preferences/plugin-ui') return response([]);
      preferenceCalls += 1;
      if (preferenceCalls === 1) return first;
      return response({ ok: true });
    });

    hideWidget('one');
    hideWidget('two');

    await flushQueue();
    expect(preferenceCalls).toBe(1);
    expect(JSON.parse(String(hanaFetchMock.mock.calls[0][1]?.body))).toEqual({
      hiddenWidgets: ['one'],
    });

    resolveFirst(response({ ok: true }));
    await flushQueue();

    expect(preferenceCalls).toBe(2);
    expect(JSON.parse(String(hanaFetchMock.mock.calls[1][1]?.body))).toEqual({
      hiddenWidgets: ['one', 'two'],
    });
  });

  it('persists tab ordering through the same preference path', async () => {
    hanaFetchMock.mockResolvedValue(response({ ok: true }));

    reorderTabs(['channels', 'plugin:demo']);

    expect(state.tabOrder).toEqual(['channels', 'plugin:demo']);
    await flushQueue();
    expect(hanaFetchMock).toHaveBeenCalledWith(
      '/api/preferences/plugin-ui',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('shows a hidden widget locally without changing the persisted order of other widgets', async () => {
    state.hiddenWidgets = ['one', 'two'];
    hanaFetchMock.mockResolvedValue(response({ ok: true }));

    showWidget('one');

    expect(state.hiddenWidgets).toEqual(['two']);
    await flushQueue();
    expect(JSON.parse(String(hanaFetchMock.mock.calls[0][1]?.body))).toEqual({
      hiddenWidgets: ['two'],
    });
  });
});
