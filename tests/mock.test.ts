import { beforeEach, describe, expect, it } from 'vitest';
import { diffSettings } from '../src/core/settings';
import { createMockSession, resetMockMouse } from '../src/mock/mock-mouse';
import { registry } from '../src/drivers';

beforeEach(() => resetMockMouse());

describe('mock mouse', () => {
  it('reads every section its capabilities declare', async () => {
    const session = createMockSession({ latencyMs: 0 });
    const settings = await session.read();
    expect(settings.dpi?.stages.length).toBeGreaterThan(0);
    expect(session.capabilities.pollingRate?.rates).toContain(settings.pollingRate);
    expect(Object.keys(settings.buttons ?? {})).toEqual(session.capabilities.buttons?.buttons.map((b) => b.id));
    expect(Object.keys(settings.extras ?? {}).sort()).toEqual(session.capabilities.extras?.map((e) => e.id).sort());
  });

  it('persists a partial write', async () => {
    const session = createMockSession({ latencyMs: 0 });
    const before = await session.read();
    const after = structuredClone(before);
    after.pollingRate = 8000;
    after.buttons!.back = { kind: 'media', action: 'next' };
    await session.write(diffSettings(before, after));
    expect(await createMockSession({ latencyMs: 0 }).read()).toEqual(after);
  });

  it('refuses invalid writes', async () => {
    const session = createMockSession({ latencyMs: 0 });
    await expect(session.write({ pollingRate: 333 })).rejects.toThrow(/not supported/);
  });

  it('is never offered for real hardware', () => {
    expect(registry.all.map((d) => d.id)).not.toContain('mock');
  });
});
