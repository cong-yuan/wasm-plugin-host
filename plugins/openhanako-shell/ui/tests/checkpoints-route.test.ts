import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

describe("checkpoints route", () => {
  it("creates explicit user-edit checkpoints through the engine boundary", async () => {
    const engine = {
      createUserEditCheckpoint: vi.fn(async ({ filePath, reason }) => ({
        id: "ckpt-1",
        path: filePath,
        reason,
      })),
    };
    const { createCheckpointsRoute } = await import("../server/routes/checkpoints.ts");
    const app = new Hono();
    app.route("/api", createCheckpointsRoute(engine));

    const res = await app.request("/api/checkpoints/user-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "/tmp/note.md", reason: "edit-start" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      checkpoint: { id: "ckpt-1", path: "/tmp/note.md", reason: "edit-start" },
    });
    expect(engine.createUserEditCheckpoint).toHaveBeenCalledWith({
      filePath: "/tmp/note.md",
      reason: "edit-start",
    });
  });

  it("rejects relative user-edit checkpoint paths", async () => {
    const engine = { createUserEditCheckpoint: vi.fn() };
    const { createCheckpointsRoute } = await import("../server/routes/checkpoints.ts");
    const app = new Hono();
    app.route("/api", createCheckpointsRoute(engine));

    const res = await app.request("/api/checkpoints/user-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "note.md", reason: "edit-start" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "absolute filePath required" });
    expect(engine.createUserEditCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects unknown user-edit checkpoint reasons", async () => {
    const engine = { createUserEditCheckpoint: vi.fn() };
    const { createCheckpointsRoute } = await import("../server/routes/checkpoints.ts");
    const app = new Hono();
    app.route("/api", createCheckpointsRoute(engine));

    const res = await app.request("/api/checkpoints/user-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "/tmp/note.md", reason: "fallback" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid reason" });
    expect(engine.createUserEditCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects traversal checkpoint ids before touching the engine", async () => {
    const engine = {
      restoreCheckpoint: vi.fn(),
      removeCheckpoint: vi.fn(),
    };
    const { createCheckpointsRoute } = await import("../server/routes/checkpoints.ts");
    const app = new Hono();
    app.route("/api", createCheckpointsRoute(engine));

    for (const [method, suffix] of [["POST", "/restore"], ["DELETE", ""]] as const) {
      const res = await app.request("/api/checkpoints/" + encodeURIComponent("../secret") + suffix, { method });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid checkpoint id" });
    }

    expect(engine.restoreCheckpoint).not.toHaveBeenCalled();
    expect(engine.removeCheckpoint).not.toHaveBeenCalled();
  });

  it("restores and removes safe checkpoint ids without mutating the id", async () => {
    const engine = {
      restoreCheckpoint: vi.fn(async (id) => ({ restoredTo: "/tmp/" + id + ".md" })),
      removeCheckpoint: vi.fn(async () => undefined),
    };
    const { createCheckpointsRoute } = await import("../server/routes/checkpoints.ts");
    const app = new Hono();
    app.route("/api", createCheckpointsRoute(engine));

    const restore = await app.request("/api/checkpoints/1700000000_ab12/restore", { method: "POST" });
    expect(restore.status).toBe(200);
    expect(await restore.json()).toEqual({
      ok: true,
      restoredTo: "/tmp/1700000000_ab12.md",
    });

    const remove = await app.request("/api/checkpoints/1700000000_ab12", { method: "DELETE" });
    expect(remove.status).toBe(200);
    expect(await remove.json()).toEqual({
      ok: true,
      id: "1700000000_ab12",
    });
    expect(engine.restoreCheckpoint).toHaveBeenCalledWith("1700000000_ab12");
    expect(engine.removeCheckpoint).toHaveBeenCalledWith("1700000000_ab12");
  });
});
