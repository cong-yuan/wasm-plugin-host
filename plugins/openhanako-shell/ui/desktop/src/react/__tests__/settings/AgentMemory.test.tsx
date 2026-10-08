/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockResponse = { ok: boolean; status: number; json: () => Promise<any>; blob?: () => Promise<Blob> };

let dreamRunError: unknown = null;
let dreamStatusOverride: Record<string, unknown> | null = null;

const defaultHanaFetch = async (url: string, opts?: RequestInit): Promise<MockResponse> => {
  if (url.includes('/memories/dream/status')) {
    return { ok: true, status: 200, json: async () => dreamStatusOverride || ({ status: 'idle', runId: null, startedAt: null, lastRun: null }) };
  }
  if (url.includes('/memories/dream/runs') && opts?.method === 'POST') {
    if (dreamRunError) throw dreamRunError;
    return { ok: true, status: 202, json: async () => ({ status: 'running', runId: 'run-1', startedAt: '2026-08-08T10:00:00.000Z', lastRun: null }) };
  }
  if (url.includes('/api/agents/') && opts?.method === 'PUT') {
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  return { ok: true, status: 200, json: async () => ({
    agentId: 'hana',
    status: 'degraded',
    reason: null,
    failedSteps: ['deepMemory'],
    maxFailCount: 2,
    lastSuccessAt: '2026-06-01T10:05:00.000Z',
    lastErrorAt: '2026-06-01T10:10:00.000Z',
    steps: {
      deepMemory: {
        lastSuccessAt: null,
        lastErrorAt: '2026-06-01T10:10:00.000Z',
        lastErrorMsg: 'LLM timeout',
        failCount: 2,
      },
    },
  }) };
};

const hanaFetchMock = vi.fn(defaultHanaFetch);

vi.mock('../../settings/api', () => ({
  hanaFetch: (url: string, opts?: RequestInit) => hanaFetchMock(url, opts),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string, params?: Record<string, any>) => {
    const messages: Record<string, string> = {
      'settings.memory.sectionTitle': '记忆',
      'settings.memory.needsUtilityModel': '需要先配置 Utility 模型',
      'settings.memory.health.degraded': '记忆整理有延迟',
      'settings.memory.health.failedSteps': `异常步骤：${params?.steps}`,
      'settings.memory.health.lastError': `最近错误：${params?.time}`,
      'settings.memory.health.errorMessage': `错误：${params?.message}`,
      'settings.memory.health.steps.deepMemory': '深层记忆',
      'settings.pins.title': '置顶记忆',
      'settings.pins.hint': '优先保留',
      'settings.pins.empty': '没有置顶记忆',
      'settings.pins.addPlaceholder': '添加置顶记忆',
      'settings.memory.compiled': '当下记忆',
      'settings.memory.compiledHint': '助手记住的重要内容',
      'settings.memory.compiledView': '查看当下记忆',
      'settings.memory.dream.title': 'Dream 整理',
      'settings.memory.dream.hint': '按客观证据整理',
      'settings.memory.dream.autoLabel': '每日自动 Dream（实验）',
      'settings.memory.dream.autoHint': '默认关闭',
      'settings.memory.dream.run': '整理当下记忆',
      'settings.memory.dream.running': '正在整理…',
      'settings.memory.dream.restore': '恢复 Dream 前版本',
      'settings.memory.dream.restoring': '正在恢复…',
      'settings.memory.dream.view': '查看整理结果',
      'settings.memory.dream.failed': '整理失败',
      'settings.memory.dream.errors.startFailed': '暂时无法开始 Dream 整理，请稍后重试',
      'settings.memory.dream.errors.statusLoadFailed': '暂时无法读取 Dream 状态，请稍后重试',
      'error.code.dreamMemoryBusy': '记忆正在后台整理，请稍后再试',
      'error.code.dreamRunFailed': 'Dream 整理失败，原记忆没有改动',
      'settings.memory.allMemories': '所有记忆',
      'settings.memory.actions.view': '查看记忆',
      'settings.memory.actions.clear': '清除记忆',
      'settings.memory.actions.export': '导出记忆',
      'settings.memory.actions.import': '导入记忆',
      'settings.memory.actions.exportSuccess': '导出成功',
      'settings.memory.actions.importSuccess': `已导入 ${params?.count} 条记忆`,
      'settings.memory.actions.importing': '正在导入...',
      'settings.memory.actions.invalidFile': '无效的记忆文件',
    };
    return messages[key] ?? key;
  },
  autoSaveConfig: vi.fn(async () => true),
  refreshSettingsConfigSnapshot: vi.fn(async () => undefined),
  savePins: vi.fn(),
}));

describe('Agent memory settings health notice', () => {
  beforeEach(() => {
    hanaFetchMock.mockReset();
    hanaFetchMock.mockImplementation(defaultHanaFetch);
    dreamRunError = null;
    dreamStatusOverride = null;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a memory failure notice in the Agent memory section', async () => {
    const { MemorySection } = await import('../../settings/tabs/agent/AgentMemory');

    render(
      <MemorySection
        agentId="hana"
        hasUtilityModel
        memoryEnabled
        currentPins={[]}
      />,
    );

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith(
        '/api/memories/health?agentId=hana',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(await screen.findByText('记忆整理有延迟')).toBeInTheDocument();
    expect(screen.getByText('异常步骤：深层记忆')).toBeInTheDocument();
    expect(screen.getByText('错误：LLM timeout')).toBeInTheDocument();
  });

  it('targets manual and automatic Dream controls at the explicit Agent', async () => {
    const { MemorySection } = await import('../../settings/tabs/agent/AgentMemory');

    render(
      <MemorySection
        agentId="agent-b"
        hasUtilityModel
        memoryEnabled
        autoDreamEnabled={false}
        currentPins={[]}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '整理当下记忆' }));
    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith(
        '/api/memories/dream/runs?agentId=agent-b',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const dreamToggle = screen.getAllByRole('switch')
      .find((element) => element.getAttribute('aria-checked') === 'false');
    expect(dreamToggle).toBeDefined();
    fireEvent.click(dreamToggle!);
    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith(
        '/api/agents/agent-b/config',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ memory: { dream: { auto_enabled: true } } }),
        }),
      );
    });
  });

  it('exports and imports the selected agent memories through the memory backup actions', async () => {
    const { MemorySection } = await import('../../settings/tabs/agent/AgentMemory');
    const originalCreateElement = document.createElement.bind(document);
    const downloaded = originalCreateElement('a');
    const clickSpy = vi.spyOn(downloaded, 'click').mockImplementation(() => {});
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'a') return downloaded;
      return originalCreateElement(tagName);
    }) as typeof document.createElement);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:memory-export');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    hanaFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/memories/export?agentId=hana') {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          blob: async () => new Blob([JSON.stringify({ version: 2, facts: [{ fact: 'likes tea' }] })], {
            type: 'application/json',
          }),
        };
      }
      if (url === '/api/memories/import?agentId=hana' && opts?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ ok: true, imported: 1 }) };
      }
      if (url.includes('/memories/health')) {
        return { ok: true, status: 200, json: async () => ({ status: 'healthy', failedSteps: [], steps: {}, maxFailCount: 0, lastSuccessAt: null, lastErrorAt: null }) };
      }
      if (url.includes('/memories/dream/status')) {
        return { ok: true, status: 200, json: async () => ({ status: 'idle', runId: null, startedAt: null, lastRun: null }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <MemorySection
        agentId="hana"
        hasUtilityModel
        memoryEnabled
        currentPins={[]}
      />,
    );

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    fireEvent.click(screen.getByRole('button', { name: '导出记忆' }));
    await waitFor(() => {
      expect(hanaFetchMock.mock.calls.some(([url]) => url === '/api/memories/export?agentId=hana')).toBe(true);
    });
    expect(downloaded.download).toMatch(/^hana-memory-hana-\d{4}-\d{2}-\d{2}\.json$/);
    expect(clickSpy).toHaveBeenCalledOnce();

    const input = document.querySelector('input[type="file"][accept=".json,application/json"]') as HTMLInputElement;
    const file = new File([JSON.stringify({ version: 2, facts: [{ fact: 'likes tea' }] })], 'memory.json', {
      type: 'application/json',
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith(
        '/api/memories/import?agentId=hana',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ facts: [{ fact: 'likes tea' }] }),
        }),
      );
    });
    expect(dispatchSpy.mock.calls.some(([event]) => event.type === 'hana-memories-changed')).toBe(true);
    dispatchSpy.mockRestore();
  });

  it('localizes a coded Dream start rejection instead of exposing backend English', async () => {
    dreamRunError = Object.assign(new Error('Memory maintenance is currently running; try Dream again shortly'), {
      code: 'dream_memory_busy',
    });
    const { MemorySection } = await import('../../settings/tabs/agent/AgentMemory');
    render(<MemorySection agentId="hana" hasUtilityModel memoryEnabled currentPins={[]} />);

    fireEvent.click(await screen.findByRole('button', { name: '整理当下记忆' }));

    expect(await screen.findByText('记忆正在后台整理，请稍后再试')).toBeInTheDocument();
    expect(screen.queryByText('Memory maintenance is currently running; try Dream again shortly')).not.toBeInTheDocument();
  });

  it('uses an action-specific localized fallback for an uncoded English failure', async () => {
    dreamRunError = new Error('settings hanaFetch: server connection not ready');
    const { MemorySection } = await import('../../settings/tabs/agent/AgentMemory');
    render(<MemorySection agentId="hana" hasUtilityModel memoryEnabled currentPins={[]} />);

    fireEvent.click(await screen.findByRole('button', { name: '整理当下记忆' }));

    expect(await screen.findByText('暂时无法开始 Dream 整理，请稍后重试')).toBeInTheDocument();
    expect(screen.queryByText('settings hanaFetch: server connection not ready')).not.toBeInTheDocument();
  });

  it('localizes a persisted failed Dream report by its optional error code', async () => {
    dreamStatusOverride = {
      status: 'failed',
      runId: null,
      startedAt: null,
      lastRun: {
        runId: 'run-failed', status: 'failed', startedAt: '2026-08-08T10:00:00.000Z',
        finishedAt: '2026-08-08T10:00:01.000Z', beforeChars: 100, afterChars: 100,
        mergedCount: 0, forgottenCount: 0, reviewedCount: 0, model: 'test', revisionId: null,
        error: 'Dream verification failed: unsupportedClaims=1', errorCode: 'dream_run_failed',
      },
    };
    const { MemorySection } = await import('../../settings/tabs/agent/AgentMemory');
    render(<MemorySection agentId="hana" hasUtilityModel memoryEnabled currentPins={[]} />);

    expect(await screen.findByText('Dream 整理失败，原记忆没有改动')).toBeInTheDocument();
    expect(screen.queryByText('Dream verification failed: unsupportedClaims=1')).not.toBeInTheDocument();
  });
});
