import { describe, expect, it } from 'vitest';
import { intercepts, interceptsWithCapabilities } from '../studio-backend/studio-backend-bridge';

describe('Studio backend bridge file/workbench coverage', () => {
  it('keeps file/workbench/preview routes out of Studio until native host commands exist', () => {
    expect(intercepts('/api/workbench/files')).toBe(false);
    expect(intercepts('/api/workbench/search')).toBe(false);
    expect(intercepts('/api/workbench/content')).toBe(false);
    expect(intercepts('/api/workbench/actions')).toBe(false);
    expect(intercepts('/api/mobile/workbench/files')).toBe(false);
    expect(intercepts('/api/mobile/workbench/search')).toBe(false);
    expect(intercepts('/api/mobile/workbench/content')).toBe(false);
    expect(intercepts('/api/mobile/workbench/actions')).toBe(false);
    expect(intercepts('/api/file-history/files')).toBe(false);
    expect(intercepts('/api/resource-io/read')).toBe(false);
    expect(intercepts('/api/resources/res_sf_report')).toBe(false);
    expect(intercepts('/api/desk/files')).toBe(false);
  });
  it('enables only the workbench operations advertised by Studio', () => {
    const read = new Set(['workbench_list_files', 'workbench_read_file']);
    const full = new Set([
      'workbench_list_files',
      'workbench_read_file',
      'workbench_write_file',
      'workbench_search_files',
      'workbench_rename_file',
      'workbench_move_file',
      'workbench_safe_delete',
      'workbench_upload_file',
    ]);

    expect(interceptsWithCapabilities('/api/workbench/files', read, 'GET')).toBe(true);
    expect(interceptsWithCapabilities('/api/workbench/content', read, 'HEAD')).toBe(true);
    expect(interceptsWithCapabilities('/api/workbench/search', read, 'GET')).toBe(false);
    expect(interceptsWithCapabilities('/api/workbench/actions', read, 'POST', {
      action: 'writeText',
      name: 'x.txt',
      content: 'x',
    })).toBe(false);
    expect(interceptsWithCapabilities('/api/workbench/actions', read, 'POST', {
      action: 'rename',
      oldName: 'x.txt',
      newName: 'y.txt',
    })).toBe(false);
    expect(interceptsWithCapabilities('/api/workbench/upload', read, 'POST', {
      name: 'x.txt',
      contentBase64: 'eA==',
    })).toBe(false);

    expect(interceptsWithCapabilities('/api/workbench/search', full, 'GET')).toBe(true);
    expect(interceptsWithCapabilities('/api/workbench/actions', full, 'POST', {
      action: 'writeText',
      name: 'x.txt',
      content: 'x',
    })).toBe(true);
    expect(interceptsWithCapabilities('/api/workbench/actions', full, 'POST', {
      action: 'rename',
      oldName: 'x.txt',
      newName: 'y.txt',
    })).toBe(true);
    expect(interceptsWithCapabilities('/api/workbench/actions', full, 'POST', {
      action: 'move',
      name: 'x.txt',
      destSubdir: 'archive',
    })).toBe(true);
    expect(interceptsWithCapabilities('/api/workbench/actions', full, 'POST', {
      action: 'safeDelete',
      name: 'x.txt',
    })).toBe(true);
    expect(interceptsWithCapabilities('/api/workbench/upload', full, 'POST', {
      name: 'x.txt',
      contentBase64: 'eA==',
    })).toBe(true);
    expect(interceptsWithCapabilities('/api/desk/files', full, 'GET')).toBe(false);
  });


  it('keeps legacy Desk file operations on Hana until Studio exposes host commands', () => {
    expect(intercepts('/api/desk/files')).toBe(false);
    expect(intercepts('/api/desk/search-files')).toBe(false);
    expect(intercepts('/api/desk/jian')).toBe(false);
    expect(intercepts('/api/desk/activities')).toBe(false);
  });

  it('keeps file history and resource preview APIs on Hana until Studio exposes host commands', () => {
    expect(intercepts('/api/file-history/files')).toBe(false);
    expect(intercepts('/api/file-history/versions')).toBe(false);
    expect(intercepts('/api/file-history/restore')).toBe(false);
    expect(intercepts('/api/resource-io/read')).toBe(false);
    expect(intercepts('/api/resource-io/write')).toBe(false);
    expect(intercepts('/api/resource-io/events')).toBe(false);
    expect(intercepts('/api/resources/res_sf_report')).toBe(false);
    expect(intercepts('/api/resources/res_sf_report/content')).toBe(false);
  });

  it('does not widen the bridge to unrelated legacy Desk APIs', () => {
    expect(intercepts('/api/desk/cron')).toBe(true);
    expect(intercepts('/api/desk/skills')).toBe(false);
    expect(intercepts('/api/desk/activities')).toBe(false);
    expect(intercepts('/api/unknown')).toBe(false);
  });
});
