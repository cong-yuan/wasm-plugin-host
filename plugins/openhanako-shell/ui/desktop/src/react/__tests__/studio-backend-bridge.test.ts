import { describe, expect, it } from 'vitest';
import { intercepts } from '../studio-backend/studio-backend-bridge';

describe('Studio backend bridge file/workbench coverage', () => {
  it('routes native workbench file operations through Studio', () => {
    expect(intercepts('/api/workbench/files')).toBe(true);
    expect(intercepts('/api/workbench/search')).toBe(true);
    expect(intercepts('/api/workbench/content')).toBe(true);
    expect(intercepts('/api/workbench/actions')).toBe(true);
    expect(intercepts('/api/mobile/workbench/files')).toBe(true);
    expect(intercepts('/api/mobile/workbench/search')).toBe(true);
    expect(intercepts('/api/mobile/workbench/content')).toBe(true);
    expect(intercepts('/api/mobile/workbench/actions')).toBe(true);
  });

  it('routes legacy Desk file operations used by the compatibility UI', () => {
    expect(intercepts('/api/desk/files')).toBe(true);
    expect(intercepts('/api/desk/search-files')).toBe(true);
    expect(intercepts('/api/desk/jian')).toBe(true);
    expect(intercepts('/api/desk/activities')).toBe(false);
  });

  it('routes durable file history and resource preview APIs', () => {
    expect(intercepts('/api/file-history/files')).toBe(true);
    expect(intercepts('/api/file-history/versions')).toBe(true);
    expect(intercepts('/api/file-history/restore')).toBe(true);
    expect(intercepts('/api/resource-io/read')).toBe(true);
    expect(intercepts('/api/resource-io/write')).toBe(true);
    expect(intercepts('/api/resource-io/events')).toBe(true);
    expect(intercepts('/api/resources/res_sf_report')).toBe(true);
    expect(intercepts('/api/resources/res_sf_report/content')).toBe(true);
  });

  it('does not widen the bridge to unrelated legacy Desk APIs', () => {
    expect(intercepts('/api/desk/cron')).toBe(true);
    expect(intercepts('/api/desk/skills')).toBe(false);
    expect(intercepts('/api/desk/activities')).toBe(false);
    expect(intercepts('/api/unknown')).toBe(false);
  });
});
