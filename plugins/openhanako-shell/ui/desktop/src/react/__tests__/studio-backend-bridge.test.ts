import { describe, expect, it } from 'vitest';
import { intercepts, interceptsWithCapabilities } from '../studio-backend/studio-backend-bridge';

describe('Studio backend bridge file/workbench coverage', () => {
  it('keeps file/workbench/preview routes capability-gated on the Studio host', () => {
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

  it('keeps file history and resource preview on Hana until native capabilities are advertised', () => {
    expect(intercepts('/api/file-history/files')).toBe(false);
    expect(intercepts('/api/file-history/versions')).toBe(false);
    expect(intercepts('/api/file-history/restore')).toBe(false);
    expect(intercepts('/api/resource-io/read')).toBe(false);
    expect(intercepts('/api/resource-io/write')).toBe(false);
    expect(intercepts('/api/resource-io/events')).toBe(false);
    expect(intercepts('/api/resources/res_sf_report')).toBe(false);
    expect(intercepts('/api/resources/res_sf_report/content')).toBe(false);

    const fileHistory = new Set([
      'file_history_list_files',
      'file_history_list_versions',
      'file_history_get_snapshot',
      'file_history_restore',
    ]);
    expect(interceptsWithCapabilities('/api/file-history/files', fileHistory, 'GET')).toBe(true);
    expect(interceptsWithCapabilities('/api/file-history/versions', fileHistory, 'GET')).toBe(true);
    expect(interceptsWithCapabilities('/api/file-history/snapshot', fileHistory, 'GET')).toBe(true);
    expect(interceptsWithCapabilities('/api/file-history/restore', fileHistory, 'POST')).toBe(true);
    expect(interceptsWithCapabilities('/api/file-history/restore', fileHistory, 'GET')).toBe(false);
    expect(interceptsWithCapabilities('/api/file-history/files', new Set(['file_history_list_files']), 'GET')).toBe(true);
    expect(interceptsWithCapabilities('/api/file-history/versions', new Set(['file_history_list_files']), 'GET')).toBe(false);

    const resourceIO = new Set([
      'resource_io_stat',
      'resource_io_read',
      'resource_io_list',
      'resource_io_search',
      'resource_io_write',
      'resource_io_write_expected_version',
      'resource_io_rename',
      'resource_io_move',
      'resource_io_trash',
    ]);
    expect(interceptsWithCapabilities('/api/resource-io/read', resourceIO, 'POST')).toBe(true);
    expect(interceptsWithCapabilities('/api/resource-io/write', resourceIO, 'POST')).toBe(true);
    expect(interceptsWithCapabilities('/api/resource-io/rename', resourceIO, 'POST')).toBe(true);
    expect(interceptsWithCapabilities('/api/resource-io/events', resourceIO, 'GET')).toBe(false);
    expect(interceptsWithCapabilities('/api/resource-io/write', new Set(['resource_io_read']), 'POST')).toBe(false);

    const preview = new Set(['resource_get_metadata', 'resource_read_content']);
    expect(interceptsWithCapabilities('/api/resources/res_sf_report', preview, 'GET')).toBe(true);
    expect(interceptsWithCapabilities('/api/resources/res_sf_report/content', preview, 'GET')).toBe(true);
    expect(interceptsWithCapabilities('/api/resources/res_sf_report/content', preview, 'HEAD')).toBe(true);
    expect(interceptsWithCapabilities('/api/resources/res_sf_report/ticket', preview, 'POST')).toBe(false);
    expect(interceptsWithCapabilities('/api/resources/res_sf_report/content', new Set(['resource_get_metadata']), 'GET')).toBe(false);

    const checkpoints = new Set([
      'checkpoint_list',
      'checkpoint_create_user_edit',
      'checkpoint_restore',
      'checkpoint_remove',
    ]);
    expect(interceptsWithCapabilities('/api/checkpoints', checkpoints, 'GET')).toBe(true);
    expect(interceptsWithCapabilities('/api/checkpoints/user-edit', checkpoints, 'POST', {
      filePath: '/workspace/note.md',
      reason: 'edit-start',
    })).toBe(true);
    expect(interceptsWithCapabilities('/api/checkpoints/1700000000_ab12/restore', checkpoints, 'POST')).toBe(true);
    expect(interceptsWithCapabilities('/api/checkpoints/1700000000_ab12', checkpoints, 'DELETE')).toBe(true);
    expect(interceptsWithCapabilities('/api/checkpoints/1700000000_ab12/restore', new Set(['checkpoint_list']), 'POST')).toBe(false);
    expect(interceptsWithCapabilities('/api/checkpoints/1700000000_ab12', new Set(['checkpoint_restore']), 'DELETE')).toBe(false);
  });

  it('does not widen the bridge to unrelated legacy Desk APIs', () => {
    expect(intercepts('/api/desk/cron')).toBe(true);
    expect(intercepts('/api/desk/skills')).toBe(false);
    expect(intercepts('/api/desk/activities')).toBe(false);
    expect(intercepts('/api/unknown')).toBe(false);
  });
});
