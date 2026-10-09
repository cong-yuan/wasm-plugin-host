// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationPanel } from '../../components/AutomationPanel';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

const addToast = vi.fn();

describe('AutomationPanel', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    addToast.mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(hanaFetch).mockImplementation(async (url) => {
      if (url === '/api/models') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    });
    useStore.setState({
      activePanel: 'automation',
      agents: [{ id: 'hanako', name: 'Hanako', yuan: 'hanako', homeFolder: '/home/hanako', isPrimary: true }],
      currentAgentId: 'hanako',
      currentSessionId: 'session-main',
      currentSessionPath: '/sessions/main.jsonl',
      sessions: [{ sessionId: 'session-main', path: '/sessions/main.jsonl', cwd: '/workspace' }],
      deskBasePath: '/workspace',
      deskWorkspaceMountId: null,
      homeFolder: '/home/hanako',
      workspaceFolders: ['/workspace'],
      sessionAuthorizedFoldersByPath: { '/sessions/main.jsonl': [] },
      addToast,
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('creates an editable native disabled draft without a prompt or fictional per-job model picker', async () => {
    let posted: Record<string, unknown> | null = null;
    vi.mocked(hanaFetch).mockImplementation(async (url, options) => {
      if (url === '/api/models') return new Response(JSON.stringify({
        models: [{ id: 'test', provider: 'mock', name: 'Test model' }],
      }), { status: 200 });
      if (url === '/api/desk/cron' && options?.method === 'POST') {
        posted = JSON.parse(String(options.body || '{}'));
        return new Response(JSON.stringify({ ok: true, job: {
          id: 'draft-1', type: 'cron', schedule: '0 9 * * *',
          label: 'automation.newAutomation', prompt: '', enabled: false,
          actorAgentId: 'hanako',
        } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, schedulerAvailable: true,
        jobs: posted ? [{ id: 'draft-1', type: 'cron', schedule: '0 9 * * *',
          label: 'automation.newAutomation', prompt: '', enabled: false,
          actorAgentId: 'hanako' }] : [],
      }), { status: 200 });
    });
    render(<AutomationPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'automation.add' }));
    await waitFor(() => expect(posted).toEqual(expect.objectContaining({
      action: 'add', prompt: '', enabled: false, actorAgentId: 'hanako',
    })));
    await screen.findByRole('button', { name: /automation.newAutomation/ });
    expect(screen.queryByText('rightWorkspace.session.model')).not.toBeInTheDocument();
    expect(addToast).not.toHaveBeenCalledWith(expect.anything(), 'error');
  });

  it('runs a saved automation immediately and refreshes the task list', async () => {
    let runCount = 0;
    vi.mocked(hanaFetch).mockImplementation(async (url, options) => {
      if (url === '/api/models') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      if (url === '/api/desk/cron' && options?.method === 'POST') {
        const body = JSON.parse(String(options.body || '{}'));
        if (body.action === 'run') {
          runCount += 1;
          return new Response(JSON.stringify({
            ok: true,
            status: 'dispatched',
            job: {
              id: 'job-1',
              label: 'Morning task',
              type: 'cron',
              schedule: '0 9 * * *',
              enabled: true,
              nextRunAt: '2026-10-09T01:00:00.000Z',
              prompt: 'say hi',
              actorAgentId: 'hanako',
            },
          }), { status: 200 });
        }
      }
      return new Response(JSON.stringify({
        jobs: [{
          id: 'job-1',
          label: 'Morning task',
          type: 'cron',
          schedule: '0 9 * * *',
          enabled: true,
          nextRunAt: '2026-10-09T01:00:00.000Z',
          prompt: 'say hi',
          actorAgentId: 'hanako',
        }],
      }), { status: 200 });
    });

    render(<AutomationPanel />);
    const row = await screen.findByRole('button', { name: /Morning task/ });
    fireEvent.click(row);
    const runButton = await screen.findByRole('button', { name: 'automation.runNow' });
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(runCount).toBe(1);
      expect(addToast).toHaveBeenCalledWith('Task sent to Agent; turn completion is not yet confirmed', 'success');
    });
    expect(hanaFetch).toHaveBeenCalledWith('/api/desk/cron', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'run', id: 'job-1' }),
      throwOnHttpError: false,
    }));
  });

  it('disables conflicting actions while another window is dispatching the job', async () => {
    vi.mocked(hanaFetch).mockImplementation(async (url, options) => {
      if (url === '/api/models') return new Response(JSON.stringify({ models: [] }), { status: 200 });
      if (url === '/api/desk/cron' && options?.method === 'POST') {
        throw new Error('running task must not be mutated');
      }
      return new Response(JSON.stringify({ jobs: [{ id: 'active-job',
        label: 'Active cross-window task', type: 'cron', schedule: '0 9 * * *',
        enabled: true, running: true, prompt: 'Do work', actorAgentId: 'hanako',
      }] }), { status: 200 });
    });
    render(<AutomationPanel />);
    const row = await screen.findByRole('button', { name: /Active cross-window task/ });
    fireEvent.click(row);
    expect(screen.getByText('Dispatch in progress')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'automation.running' })).toBeDisabled();
    const nativeToggle = document.querySelector<HTMLElement>('.hana-toggle');
    expect(nativeToggle).toHaveAttribute('aria-disabled', 'true');
    if (nativeToggle) fireEvent.click(nativeToggle);
    expect(screen.getByRole('button', { name: 'automation.delete' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'common.confirm' })).toBeDisabled();
    expect(vi.mocked(hanaFetch).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });

  it('shows a backend mutation error instead of silently accepting a failed change', async () => {
    vi.mocked(hanaFetch).mockImplementation(async (url, options) => {
      if (url === '/api/models') return new Response(JSON.stringify({ models: [] }), { status: 200 });
      if (url === '/api/desk/cron' && options?.method === 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'automation is currently running' }), { status: 409 });
      }
      return new Response(JSON.stringify({ jobs: [{ id: 'busy-toggle',
        label: 'Busy toggle task', type: 'cron', schedule: '0 9 * * *',
        enabled: true, prompt: 'Do work', actorAgentId: 'hanako',
      }] }), { status: 200 });
    });
    render(<AutomationPanel />);
    const row = await screen.findByRole('button', { name: /Busy toggle task/ });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: 'automation.delete' }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      'automation is currently running', 'error'));
  });

  it('shows the structured POST error and keeps the panel usable', async () => {
    render(<AutomationPanel />);
    await waitFor(() => expect(hanaFetch).toHaveBeenCalledWith('/api/desk/cron', {
      throwOnHttpError: false,
    }));
    vi.mocked(hanaFetch).mockImplementation(async (url, options) => {
      if (url === '/api/desk/cron' && options?.method === 'POST') {
        return new Response(JSON.stringify({
          error: {
            code: 'cron_store_corrupt',
            message: 'automation task storage is corrupt',
          },
        }), { status: 500 });
      }
      if (url === '/api/models') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    });

    const addButton = screen.getByRole('button', { name: 'automation.add' });
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        'automation.createFailed: automation task storage is corrupt',
        'error',
      );
    });
    const postCall = vi.mocked(hanaFetch).mock.calls.find(([, options]) => options?.method === 'POST');
    expect(postCall?.[1]).toEqual(expect.objectContaining({ throwOnHttpError: false }));
    expect(addButton).toBeEnabled();
  });

  it('shows a structured GET error without presenting an empty task list or clearing the badge', async () => {
    useStore.setState({ automationCount: 7 } as never);
    vi.mocked(hanaFetch).mockImplementation(async (url) => {
      if (url === '/api/desk/cron') {
        return new Response(JSON.stringify({
          error: {
            code: 'cron_store_corrupt',
            message: 'automation task storage is corrupt',
          },
        }), { status: 500 });
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    });

    render(<AutomationPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('automation task storage is corrupt');
    expect(screen.queryByText('automation.emptyForAgent')).not.toBeInTheDocument();
    expect(screen.queryByText('automation.empty')).not.toBeInTheDocument();
    expect(useStore.getState().automationCount).toBe(7);
    expect(hanaFetch).toHaveBeenCalledWith('/api/desk/cron', { throwOnHttpError: false });
  });
});
