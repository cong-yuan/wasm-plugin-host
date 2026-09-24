// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolGroupBlock } from '../../components/chat/ToolGroupBlock';

describe('ToolGroupBlock', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('renders failed, cancelled, and unknown outcomes without presenting success', () => {
    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[
          { id: 'failed', name: 'read', done: true, success: false, status: 'failed', error: 'file not found' },
          { id: 'cancelled', name: 'bash', done: true, success: false, status: 'cancelled' },
          { id: 'unknown', name: 'read', done: true, success: false, status: 'unknown' },
        ]}
      />,
    );

    expect(screen.getByText('file not found')).toBeInTheDocument();
    expect(screen.getByText('✗')).toBeInTheDocument();
    expect(screen.getByText('■')).toBeInTheDocument();
    expect(screen.getByText('!')).toBeInTheDocument();
    expect(screen.queryByText('?')).not.toBeInTheDocument();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
  });

  it('defers bounded argument serialization until after the expansion click paints', async () => {
    let payloadReads = 0;
    const args: Record<string, unknown> = {};
    Object.defineProperty(args, 'payload', {
      enumerable: true,
      get() {
        payloadReads += 1;
        return 'large output';
      },
    });

    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[{ id: 'lazy', name: 'custom_tool', args, done: true, success: true }]}
      />,
    );

    expect(payloadReads).toBe(0);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(payloadReads).toBe(0);
    await waitFor(() => expect(screen.getByText(/large output/)).toBeInTheDocument());
    expect(payloadReads).toBe(1);
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(/large output/)).toBeInTheDocument();
    expect(payloadReads).toBe(1);
  });

  it('limits huge tool details before mounting them into the DOM', async () => {
    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[{
          id: 'huge',
          name: 'custom_tool',
          args: { payload: 'x'.repeat(100_000) },
          done: true,
          success: true,
          output: 'y'.repeat(100_000),
        }]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await waitFor(() => expect(document.querySelectorAll('pre')).toHaveLength(2));
    expect(screen.getAllByText(/\[truncated\]/)).toHaveLength(2);
    const previews = Array.from(document.querySelectorAll('pre')).map(node => node.textContent || '');
    expect(previews).toHaveLength(2);
    expect(previews.every(value => value.length <= 64 * 1024)).toBe(true);
  });

  it('renders Qoder-style per-tool Input/Response details as escaped text', async () => {
    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[{
          id: 'output',
          name: 'bash',
          args: { command: 'npm test' },
          done: true,
          success: true,
          output: '<script>alert(1)</script>\n12 tests passed',
        }]}
      />,
    );

    expect(screen.queryByText('toolGroup.response')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await waitFor(() => expect(screen.getByText('toolGroup.input')).toBeInTheDocument());
    expect(screen.getByText('toolGroup.response')).toBeInTheDocument();
    const output = screen.getByText(/<script>alert\(1\)<\/script>/);
    expect(output.tagName).toBe('PRE');
    expect(document.querySelector('script')).toBeNull();
  });

  it('renders edit oldText/newText as a deferred side-by-side diff', async () => {
    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[{
          id: 'edit-diff',
          name: 'edit',
          args: {
            path: '/repo/example.ts',
            edits: [{ oldText: 'same\nold line\ntail', newText: 'same\nnew line\ntail' }],
          },
          done: true,
          success: true,
          output: 'Successfully replaced 1 block.',
        }]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(document.querySelector('[data-tool-edit-diff]')).toBeNull();
    await waitFor(() => expect(document.querySelector('[data-tool-edit-diff]')).toBeInTheDocument());

    expect(document.querySelector('[data-diff-side="old"][data-diff-kind="removed"]'))
      .toHaveTextContent('old line');
    expect(document.querySelector('[data-diff-side="new"][data-diff-kind="added"]'))
      .toHaveTextContent('new line');
    expect(document.querySelector('[data-tool-edit-diff]'))
      .toHaveTextContent('/repo/example.ts');
    expect(screen.getByText('Successfully replaced 1 block.')).toBeInTheDocument();
  });

  it('does not interpret oldText/newText fields from unrelated tools as an edit diff', async () => {
    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[{
          id: 'not-edit',
          name: 'custom_tool',
          args: { oldText: 'old', newText: 'new' },
          done: true,
          success: true,
        }]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await waitFor(() => expect(screen.getByText('toolGroup.input')).toBeInTheDocument());
    expect(document.querySelector('[data-tool-edit-diff]')).toBeNull();
  });

  it('shows a useful technical name, longer command summary, and elapsed time', () => {
    const command = `${'printf x '.repeat(12)}done`;

    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[{
          name: 'exec_command',
          args: { cmd: command },
          done: true,
          success: true,
          startedAt: 1_000,
          finishedAt: 3_000,
        }]}
      />,
    );

    expect(screen.getByText('exec_command')).toBeInTheDocument();
    expect(screen.getByText('2s')).toBeInTheDocument();
    const detail = screen.getByTitle(command);
    expect(detail.textContent).toHaveLength(command.length);
    expect(screen.queryByText(/用完电脑|用完插件/)).not.toBeInTheDocument();
  });

  it('renders write_stdin with its technical name and useful input summary', () => {
    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[{
          name: 'write_stdin',
          args: { process_id: 'term_1', chars: 'q\n' },
          done: true,
          success: true,
        }]}
      />,
    );

    expect(screen.getByText('write_stdin')).toBeInTheDocument();
    expect(document.querySelector('[data-tool="write_stdin"] [title]')).toHaveAttribute('title', 'q\n');
  });

  it('expands each tool independently instead of folding the whole group', async () => {
    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[
          { id: 'one', name: 'bash', args: { command: 'npm test' }, done: true, success: true, output: 'one output' },
          { id: 'two', name: 'read', args: { file_path: '/tmp/report.md' }, done: true, success: true, output: 'two output' },
        ]}
      />,
    );

    const rows = screen.getAllByRole('button', { expanded: false });
    fireEvent.click(rows[0]);
    await waitFor(() => expect(screen.getByText('one output')).toBeInTheDocument());
    expect(screen.queryByText('two output')).not.toBeInTheDocument();
    expect(screen.queryByText('toolGroup.count')).not.toBeInTheDocument();
  });

  it('keeps a single tool as a plain indicator without a fold summary', () => {
    render(
      <ToolGroupBlock
        collapsed={true}
        tools={[{
          name: 'bash',
          args: { command: 'npm test' },
          done: true,
          success: true,
        }]}
      />,
    );

    expect(screen.queryByText('toolGroup.count')).toBeNull();
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('hides automation create/update tools because the suggestion card is the UI', () => {
    const { container } = render(
      <ToolGroupBlock
        collapsed={false}
        tools={[
          {
            name: 'automation',
            args: { action: 'create', label: 'Tea' },
            done: true,
            success: true,
          },
          {
            name: 'automation',
            args: { action: 'update', id: 'job_1' },
            done: true,
            success: true,
          },
        ]}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('hides media generation tools because media blocks and output cards are the UI', () => {
    const { container } = render(
      <ToolGroupBlock
        collapsed={false}
        tools={[
          {
            name: 'media_generate-image',
            args: {
              prompt: 'Japanese anime doodle style illustration',
              resolution: '2K',
            },
            done: true,
            success: true,
          },
          {
            name: 'media_generate-video',
            args: {
              prompt: 'A short product reveal clip',
              duration: 5,
            },
            done: true,
            success: true,
          },
        ]}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('hides interactive card guide and render tools because the card is the UI', () => {
    const { container } = render(
      <ToolGroupBlock
        collapsed={false}
        tools={[
          {
            name: 'hana_card_guide',
            args: {},
            done: true,
            success: true,
          },
          {
            name: 'show_card',
            args: {
              title: 'dorm_comparison',
            },
            done: true,
            success: true,
          },
        ]}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('hides current card-backed tools while keeping visible browser and compatibility tools', () => {
    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[
          {
            name: 'workflow',
            args: { taskId: 'workflow-1', workflow: 'Morning brief' },
            done: true,
            success: true,
          },
          {
            name: 'install_skill',
            args: { skill_name: 'daily-review' },
            done: true,
            success: true,
          },
          {
            name: 'update_settings',
            args: { key: 'locale' },
            done: true,
            success: true,
          },
          {
            name: 'automation',
            args: { action: 'pending_add', label: 'Tea' },
            done: true,
            success: true,
          },
          {
            name: 'browser',
            args: { action: 'screenshot' },
            done: true,
            success: true,
          },
          {
            name: 'browser',
            args: { action: 'navigate', url: 'https://example.com' },
            done: true,
            success: true,
          },
          {
            name: 'present_files',
            args: { path: 'legacy.txt' },
            done: true,
            success: true,
          },
        ]}
      />,
    );

    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText('legacy.txt')).toBeInTheDocument();
    expect(screen.queryByText('Morning brief')).not.toBeInTheDocument();
    expect(screen.queryByText('daily-review')).not.toBeInTheDocument();
    expect(screen.queryByText('locale')).not.toBeInTheDocument();
    expect(screen.queryByText('Tea')).not.toBeInTheDocument();
  });

  it('lets tool rows and expanded details use the full assistant message width', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
    const toolGroupRule = css.match(/\.toolGroup\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(toolGroupRule).toContain('width: 100%');
    expect(toolGroupRule).toContain('max-width: 100%');
    expect(css).toContain('max-height: min(400px, 50vh)');
    expect(css).toMatch(/\.toolDetails\s*\{[^}]*contain:\s*layout paint/s);
    expect(css).toMatch(/\.toolDetailsScroller pre\s*\{[^}]*white-space:\s*pre;/s);
    expect(css).toMatch(/\.toolDiffScroller\s*\{[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/\.toolDiffRow\s*\{[^}]*grid-template-columns:/s);
    expect(toolGroupRule).toContain('box-sizing: border-box');
  });

  it('fuses consecutive subagent cards into one rounded block', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
    const leading = css.match(/\.subagentResourceCard\[data-chat-resource-card\]:has\(\+ \.subagentResourceCard\[data-chat-resource-card\]\)\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const trailing = css.match(/\.subagentResourceCard\[data-chat-resource-card\]\s*\+\s*\.subagentResourceCard\[data-chat-resource-card\]\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(leading).toContain('margin-bottom: 0');
    expect(leading).toContain('border-bottom-left-radius: 0');
    expect(leading).toContain('border-bottom-right-radius: 0');
    expect(trailing).toContain('margin-top: 0');
    expect(trailing).toContain('border-top-left-radius: 0');
    expect(trailing).toContain('border-top-right-radius: 0');
    expect(trailing).toContain('border-top: 1px solid var(--overlay-light');
  });

  it('renders the task-family container: four-corner radius, no accent quote bar', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
    const toolGroupRule = css.match(/\.toolGroup\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    expect(toolGroupRule).toContain('border-radius: var(--radius-sm)');
    expect(toolGroupRule).not.toContain('padding-left');
    expect(css).not.toMatch(/\.toolGroup::before/);
    expect(css).not.toContain('hana-tool-bar-in');

    const toolDotsRule = css.match(/\.toolDots\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    expect(toolDotsRule).toContain('color: var(--tool-text)');
  });
});
