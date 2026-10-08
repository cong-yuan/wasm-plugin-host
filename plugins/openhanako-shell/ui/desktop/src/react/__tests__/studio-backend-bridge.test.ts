import { describe, expect, it } from 'vitest';
import { intercepts } from '../studio-backend/studio-backend-bridge';

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
