import { Hono } from "hono";
import path from "path";

function resolveWorkspaceRoot(engine: any, agentId: string): string | null {
  if (!agentId) return null;
  const root = engine.getExplicitHomeCwd?.(agentId) || engine.getHomeCwd?.(agentId);
  return root ? path.resolve(root) : null;
}

function safeRelPath(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (path.isAbsolute(value) || value.includes("\\")) return null;
  const segments = value.split("/");
  if (segments.some(seg => !seg || seg === "." || seg === "..")) return null;
  return value;
}

export function createFileHistoryRoute(engine: any) {
  const route = new Hono();

  const withWorkspace = (c: any): { root: string } | Response => {
    const agentId = c.req.query("agentId") || "";
    if (!agentId) return c.json({ error: "agentId required" }, 400);
    const root = resolveWorkspaceRoot(engine, agentId);
    const service = engine.getFileHistoryService();
    if (!root || !service.hasWorkspace(root)) return c.json({ error: "workspace not tracked" }, 404);
    return { root };
  };

  route.get("/file-history/files", async (c) => {
    try {
      const resolved = withWorkspace(c);
      if (resolved instanceof Response) return resolved;
      return c.json({ files: engine.getFileHistoryService().listFiles(resolved.root) });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/file-history/versions", async (c) => {
    try {
      const resolved = withWorkspace(c);
      if (resolved instanceof Response) return resolved;
      const relPath = safeRelPath(c.req.query("relPath"));
      if (!relPath) return c.json({ error: "invalid relPath" }, 400);
      return c.json({ versions: engine.getFileHistoryService().listVersions(resolved.root, relPath) });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/file-history/snapshot", async (c) => {
    try {
      const resolved = withWorkspace(c);
      if (resolved instanceof Response) return resolved;
      const id = Number(c.req.query("id"));
      if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
      const snapshot = engine.getFileHistoryService().getSnapshotContent(resolved.root, id);
      return c.json({
        relPath: snapshot.relPath,
        capturedAt: snapshot.capturedAt,
        origin: snapshot.origin,
        content: snapshot.content.toString("utf-8"),
      });
    } catch (err: any) {
      return c.json({ error: err.message }, /not found/i.test(err.message) ? 404 : 500);
    }
  });

  route.post("/file-history/restore", async (c) => {
    try {
      const body = await c.req.json();
      const agentId = typeof body.agentId === "string" ? body.agentId : "";
      if (!agentId) return c.json({ error: "agentId required" }, 400);
      const root = resolveWorkspaceRoot(engine, agentId);
      const service = engine.getFileHistoryService();
      if (!root || !service.hasWorkspace(root)) return c.json({ error: "workspace not tracked" }, 404);
      const snapshotId = Number(body.snapshotId);
      if (!Number.isInteger(snapshotId) || snapshotId <= 0) return c.json({ error: "invalid snapshotId" }, 400);

      const snapshot = service.getSnapshotContent(root, snapshotId);
      const relPath = safeRelPath(snapshot.relPath);
      if (!relPath) return c.json({ error: "corrupt snapshot path" }, 500);
      const absPath = path.join(root, ...relPath.split("/"));

      // Native preview can pass the version of the bytes shown in the diff.
      // Enforce optimistic concurrency for that case rather than overwriting
      // work changed while the History window was open.
      const expectedVersion = body.expectedVersion;
      if (expectedVersion !== undefined) {
        const v = expectedVersion;
        const valid = v && typeof v === "object" && !Array.isArray(v)
          && (v.mtimeMs !== undefined || v.sha256 !== undefined)
          && (v.mtimeMs === undefined || (Number.isFinite(v.mtimeMs) && v.mtimeMs >= 0))
          && (v.size === undefined || v.size === null || (Number.isSafeInteger(v.size) && v.size >= 0))
          && (v.sha256 === undefined || (typeof v.sha256 === "string" && /^[a-f0-9]{64}$/.test(v.sha256)));
        if (!valid) return c.json({ error: "invalid expectedVersion" }, 400);
      }
      // 还原走 ResourceIO：工作区树/编辑器沿既有事件链路刷新，还原动作本身也进历史（可反悔）
      const resourceIO = engine.getResourceIO();
      if (expectedVersion !== undefined && typeof resourceIO.writeExpectedVersion !== "function") {
        return c.json({ error: "versioned restore unavailable" }, 501);
      }
      const target = { kind: "local-file", path: absPath };
      const writeResult = expectedVersion !== undefined
        ? await resourceIO.writeExpectedVersion(target, snapshot.content, expectedVersion, {})
        : await resourceIO.write(target, snapshot.content, {});
      // ResourceIO may report a version conflict as a result rather than throwing.
      // Never capture a "restore" snapshot, or acknowledge success, if the write failed.
      if (writeResult?.ok === false) {
        if (writeResult.conflict === true) {
          return c.json({ error: writeResult.safeMessage || "Resource write conflict", conflict: true }, 409);
        }
        return c.json({ error: writeResult.safeMessage || "Resource write failed" }, 500);
      }
      await service.captureNow(root, relPath, "restore");
      return c.json({ ok: true, relPath });
    } catch (err: any) {
      return c.json({ error: err.message }, /not found/i.test(err.message) ? 404 : 500);
    }
  });

  return route;
}
