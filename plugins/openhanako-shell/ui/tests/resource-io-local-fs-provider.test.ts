import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFsProvider } from "../lib/resource-io/providers/local-fs-provider.ts";
import { ResourceAccessPolicy } from "../lib/resource-io/resource-access-policy.ts";

const CAPABILITY_KEYS = [
  "stat",
  "read",
  "write",
  "writeExpectedVersion",
  "edit",
  "list",
  "search",
  "watch",
  "materialize",
  "copy",
  "rename",
  "move",
  "trash",
  "delete",
  "mkdir",
].sort();

describe("LocalFsProvider", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function makeProvider(check = vi.fn(() => ({ allowed: true }))) {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resource-local-fs-"));
    const cwd = path.join(tempRoot, "workspace");
    const trashRoot = path.join(tempRoot, "trash");
    fs.mkdirSync(cwd, { recursive: true });
    const realCwd = fs.realpathSync(cwd);
    return {
      cwd,
      realCwd,
      trashRoot,
      check,
      provider: new LocalFsProvider({ cwd, guard: { check }, trashRoot }),
    };
  }

  it("declares the complete provider capability matrix", () => {
    const { provider } = makeProvider();

    expect(Object.keys(provider.capabilities()).sort()).toEqual(CAPABILITY_KEYS);
  });

  it("writes and stats a local file through PathGuard", async () => {
    const { cwd, realCwd, check, provider } = makeProvider();
    const result = await provider.write({ kind: "local-file", path: "notes/a.md" }, "hello");

    const target = path.join(cwd, "notes", "a.md");
    const realTarget = path.join(realCwd, "notes", "a.md");
    expect(fs.readFileSync(target, "utf-8")).toBe("hello");
    expect(check).toHaveBeenCalledWith(realTarget, "write");
    expect(result).toMatchObject({
      changeType: "created",
      resourceKey: `local_fs:${realTarget.replace(/\\/g, "/")}`,
      resource: { kind: "local-file", path: realTarget, filePath: realTarget, provider: "local_fs" },
      version: { size: 5 },
    });

    await provider.write({ kind: "local-file", path: "notes/a.md" }, "hello again");
    const stat = await provider.stat({ kind: "local-file", path: "notes/a.md" });
    expect(stat).toMatchObject({ exists: true, isDirectory: false, version: { size: 11 } });
  });

  it("denies writes outside the guard", async () => {
    const { provider } = makeProvider(vi.fn(() => ({ allowed: false, reason: "denied by test" })));

    await expect(provider.write({ kind: "local-file", path: "blocked.md" }, "x"))
      .rejects.toMatchObject({
        code: "resource_access_denied",
        status: 403,
        operation: "write",
        message: "denied by test",
      });
  });

  it("propagates typed authority denials without losing safe messages", async () => {
    const { provider } = makeProvider(vi.fn(() => ({
      allowed: false,
      code: "path_outside_authorized_roots",
      reason: "outside /secret/path",
      safeMessage: "Resource is outside authorized roots",
    })));

    await expect(provider.write({ kind: "local-file", path: "blocked.md" }, "x"))
      .rejects.toMatchObject({
        code: "resource_access_denied",
        reason: "path_outside_authorized_roots",
        safeMessage: "Resource is outside authorized roots",
      });
  });

  it("allows missing-path writes under authorized parents and rejects outside writes", async () => {
    const { cwd, provider } = makeProviderWithPolicy();

    await expect(provider.write({ kind: "local-file", path: "new/deep/note.md" }, "ok"))
      .resolves.toMatchObject({ changeType: "created" });
    expect(fs.readFileSync(path.join(cwd, "new", "deep", "note.md"), "utf-8")).toBe("ok");

    await expect(provider.write({ kind: "local-file", path: path.join(path.dirname(cwd), "outside.md") }, "no"))
      .rejects.toMatchObject({
        code: "resource_access_denied",
        reason: "path_outside_authorized_roots",
      });
  });

  it("rejects symlink writes that escape the authorized workspace", async () => {
    const { cwd, provider } = makeProviderWithPolicy();
    const outside = path.join(path.dirname(cwd), "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.md"), "secret");
    fs.symlinkSync(outside, path.join(cwd, "linked"), "dir");

    await expect(provider.write({ kind: "local-file", path: "linked/secret.md" }, "overwrite"))
      .rejects.toMatchObject({
        code: "resource_access_denied",
        reason: "path_outside_authorized_roots",
      });
    expect(fs.readFileSync(path.join(outside, "secret.md"), "utf-8")).toBe("secret");
  });

  it("reads, lists, searches, copies, deletes, and materializes local files", async () => {
    const { cwd, realCwd, provider } = makeProvider();
    await provider.write({ kind: "local-file", path: "a.md" }, "alpha");
    await provider.mkdir({ kind: "local-file", path: "nested" });
    await provider.write({ kind: "local-file", path: "nested/b.md" }, "beta alpha");

    const read = await provider.read({ kind: "local-file", path: "a.md" });
    expect(read.content.toString("utf-8")).toBe("alpha");
    const { createHash } = await import("crypto");
    expect(read.version?.sha256).toBe(createHash("sha256").update("alpha").digest("hex"));

    const list = await provider.list({ kind: "local-file", path: "." });
    expect(list.items.map((item) => item.name)).toEqual(expect.arrayContaining(["a.md", "nested"]));

    const search = await provider.search({ kind: "local-file", path: "." }, { query: "alpha" });
    expect(search.matches.map((match) => path.relative(realCwd, match.filePath).replace(/\\/g, "/"))).toEqual([
      "a.md",
      "nested/b.md",
    ]);

    const copy = await provider.copy(
      { kind: "local-file", path: "a.md" },
      { kind: "local-file", path: "copy.md" },
    );
    expect(copy.changeType).toBe("created");
    expect(fs.readFileSync(path.join(cwd, "copy.md"), "utf-8")).toBe("alpha");

    const materialized = await provider.materialize({ kind: "local-file", path: "copy.md" });
    expect(materialized.filePath).toBe(path.join(realCwd, "copy.md"));

    const deleted = await provider.delete({ kind: "local-file", path: "copy.md" });
    expect(deleted.resourceKey).toBe(`local_fs:${path.join(realCwd, "copy.md").replace(/\\/g, "/")}`);
    expect(fs.existsSync(path.join(cwd, "copy.md"))).toBe(false);
  });

  it("maps relative file watch names back to the watched file", async () => {
    const { cwd, realCwd, provider } = makeProvider();
    const filePath = path.join(cwd, "notes", "a.md");
    const realFilePath = path.join(realCwd, "notes", "a.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "alpha");

    const target = provider.watchTarget({ kind: "local-file", path: "notes/a.md" });
    const snapshot = target.toResource("a.md");

    expect(snapshot).toMatchObject({
      resourceKey: `local_fs:${realFilePath.replace(/\\/g, "/")}`,
      resource: {
        kind: "local-file",
        provider: "local_fs",
        path: realFilePath,
        filePath: realFilePath,
      },
      filePath: realFilePath,
    });
  });

  it("detects same-size content changes with sha256 optimistic-concurrency tokens", async () => {
    const { cwd, provider } = makeProvider();
    const filePath = path.join(cwd, "draft.md");
    fs.writeFileSync(filePath, "old");
    const originalHash = await import("crypto").then(({ createHash }) =>
      createHash("sha256").update("old").digest("hex"));

    const first = await provider.writeExpectedVersion(
      { kind: "local-file", path: "draft.md" }, "new", { sha256: originalHash },
    );
    expect(first).toMatchObject({ changeType: "modified" });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("new");

    const stale = await provider.writeExpectedVersion(
      { kind: "local-file", path: "draft.md" }, "bad", { sha256: originalHash },
    );
    expect(stale).toMatchObject({ ok: false, conflict: true });
    expect(stale.version).toEqual(expect.objectContaining({ size: 3, sha256: expect.any(String) }));
    expect(fs.readFileSync(filePath, "utf-8")).toBe("new");
  });

  it("rejects empty and unsupported expected-version tokens instead of falling back to unconditional write", async () => {
    const { cwd, provider } = makeProvider();
    const filePath = path.join(cwd, "draft.md");
    fs.writeFileSync(filePath, "old");

    const empty = await provider.writeExpectedVersion(
      { kind: "local-file", path: "draft.md" }, "new", {} as any,
    );
    expect(empty).toMatchObject({ ok: false, conflict: true });
    const unsupported = await provider.writeExpectedVersion(
      { kind: "local-file", path: "draft.md" }, "new", { etag: "opaque-unknown" },
    );
    expect(unsupported).toMatchObject({ ok: false, conflict: true });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("old");
  });

  it("uses the version from an actual read for optimistic write and rejects its reuse", async () => {
    const { cwd, provider } = makeProvider();
    const filePath = path.join(cwd, "versioned.txt");
    fs.writeFileSync(filePath, "first");
    const read = await provider.read({ kind: "local-file", path: "versioned.txt" });
    expect(read.version).toMatchObject({
      size: 5,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const saved = await provider.writeExpectedVersion(
      { kind: "local-file", path: "versioned.txt" }, "second", read.version!,
    );
    expect(saved).toMatchObject({ changeType: "modified" });
    const stale = await provider.writeExpectedVersion(
      { kind: "local-file", path: "versioned.txt" }, "third", read.version!,
    );
    expect(stale).toMatchObject({ ok: false, conflict: true });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("second");
  });

  it("fails closed when another writer holds the on-disk CAS lock", async () => {
    const { cwd, provider } = makeProvider();
    const filePath = path.join(cwd, "shared.md");
    fs.writeFileSync(filePath, "original");
    const version = (await provider.stat({ kind: "local-file", path: "shared.md" })).version!;
    const lock = path.join(cwd, ".shared.md.openhanako-cas-lock");
    fs.mkdirSync(lock);
    try {
      const conflict = await provider.writeExpectedVersion(
        { kind: "local-file", path: "shared.md" }, "should not write", version,
      );
      expect(conflict).toMatchObject({ ok: false, conflict: true });
      expect(fs.readFileSync(filePath, "utf-8")).toBe("original");
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      fs.rmdirSync(lock);
    }
    const success = await provider.writeExpectedVersion(
      { kind: "local-file", path: "shared.md" }, "updated", version,
    );
    expect(success).toMatchObject({ changeType: "modified" });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("records CAS lock ownership and refuses to recover a live lock", async () => {
    const { cwd, provider } = makeProvider();
    const lock = path.join(cwd, ".shared.md.openhanako-cas-lock");
    const ref = { kind: "local-file", path: "shared.md" };
    expect(provider.inspectExpectedVersionLock(ref)).toEqual({ locked: false, owner: null });
    fs.mkdirSync(lock);
    const owner = {
      version: 1,
      nonce: "a".repeat(32),
      pid: process.pid,
      hostname: (await import("os")).hostname(),
      createdAt: Date.now() - 120_000,
    };
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner));
    expect(provider.inspectExpectedVersionLock(ref)).toEqual({ locked: true, owner });
    expect(provider.recoverOrphanedExpectedVersionLock(ref, owner.nonce)).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("requires a matching nonce and a verified dead local process to recover an orphaned lock", async () => {
    const { cwd, provider } = makeProvider();
    const lock = path.join(cwd, ".shared.md.openhanako-cas-lock");
    const ref = { kind: "local-file", path: "shared.md" };
    fs.writeFileSync(path.join(cwd, "shared.md"), "original");
    fs.mkdirSync(lock);
    const owner = {
      version: 1,
      nonce: "b".repeat(32),
      pid: 999999999,
      hostname: (await import("os")).hostname(),
      createdAt: Date.now() - 120_000,
    };
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner));

    expect(provider.recoverOrphanedExpectedVersionLock(ref, "wrong")).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    expect(provider.recoverOrphanedExpectedVersionLock(ref, owner.nonce)).toBe(true);
    expect(provider.inspectExpectedVersionLock(ref)).toEqual({ locked: false, owner: null });
    expect(fs.readFileSync(path.join(cwd, "shared.md"), "utf-8")).toBe("original");
  });

  it("does not recover a crashed lock containing unexpected files", async () => {
    const { cwd, provider } = makeProvider();
    const ref = { kind: "local-file", path: "shared.md" };
    const lock = path.join(cwd, ".shared.md.openhanako-cas-lock");
    fs.mkdirSync(lock);
    const owner = {
      version: 1,
      nonce: "c".repeat(32),
      pid: 999999999,
      hostname: (await import("os")).hostname(),
      createdAt: Date.now() - 120_000,
    };
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner));
    fs.writeFileSync(path.join(lock, "unexpected.txt"), "keep");
    expect(provider.recoverOrphanedExpectedVersionLock(ref, owner.nonce)).toBe(false);
    expect(fs.readFileSync(path.join(lock, "unexpected.txt"), "utf8")).toBe("keep");
    expect(provider.inspectExpectedVersionLock(ref)).toEqual({ locked: true, owner });
  });

  it("fails closed for ownerless and untrusted CAS locks", async () => {
    const { cwd, provider } = makeProvider();
    const lock = path.join(cwd, ".shared.md.openhanako-cas-lock");
    const ref = { kind: "local-file", path: "shared.md" };
    fs.mkdirSync(lock);
    expect(provider.inspectExpectedVersionLock(ref)).toEqual({ locked: true, owner: null });
    expect(provider.recoverOrphanedExpectedVersionLock(ref, "a".repeat(32))).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("leaves original bytes and no CAS artifacts when atomic replacement fails", async () => {
    const { cwd, provider } = makeProvider();
    const filePath = path.join(cwd, "draft.md");
    fs.writeFileSync(filePath, "keep this");
    const version = (await provider.stat({ kind: "local-file", path: "draft.md" })).version!;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated replace failure");
    });
    try {
      await expect(provider.writeExpectedVersion(
        { kind: "local-file", path: "draft.md" }, "new content", version,
      )).rejects.toThrow("simulated replace failure");
    } finally {
      rename.mockRestore();
    }
    expect(fs.readFileSync(filePath, "utf-8")).toBe("keep this");
    expect(fs.readdirSync(cwd)).toEqual(["draft.md"]);
  });

  it("preserves original file mode when an expected-version write commits", async () => {
    if (process.platform === "win32") return;
    const { cwd, provider } = makeProvider();
    const filePath = path.join(cwd, "private.md");
    fs.writeFileSync(filePath, "secret");
    fs.chmodSync(filePath, 0o600);
    const version = (await provider.stat({ kind: "local-file", path: "private.md" })).version!;
    const result = await provider.writeExpectedVersion(
      { kind: "local-file", path: "private.md" }, "updated", version,
    );
    expect(result).toMatchObject({ changeType: "modified" });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(cwd)).toEqual(["private.md"]);
  });

  it("supports expected-version writes, rename, move, and trash as ResourceIO authority operations", async () => {
    const { cwd, realCwd, trashRoot, provider } = makeProvider();
    const source = path.join(cwd, "draft.md");
    fs.writeFileSync(source, "old", "utf-8");
    const before = fs.statSync(source);

    const stale = await provider.writeExpectedVersion(
      { kind: "local-file", path: "draft.md" },
      "stale overwrite",
      { mtimeMs: before.mtimeMs - 1, size: before.size },
    );
    expect(stale).toMatchObject({
      ok: false,
      conflict: true,
      version: { size: before.size },
    });
    expect(fs.readFileSync(source, "utf-8")).toBe("old");

    const saved = await provider.writeExpectedVersion(
      { kind: "local-file", path: "draft.md" },
      "new",
      { mtimeMs: before.mtime.getTime(), size: before.size },
    );
    expect(saved).toMatchObject({ changeType: "modified", version: { size: 3 } });

    const rename = await provider.rename(
      { kind: "local-file", path: "draft.md" },
      { kind: "local-file", path: "renamed.md" },
    );
    expect(rename).toMatchObject({
      oldResource: { filePath: path.join(realCwd, "draft.md") },
      newResource: { filePath: path.join(realCwd, "renamed.md") },
    });
    expect(fs.existsSync(path.join(cwd, "draft.md"))).toBe(false);

    const move = await provider.move(
      { kind: "local-file", path: "renamed.md" },
      { kind: "local-file", path: "archive/renamed.md" },
    );
    expect(move.newResource).toMatchObject({ filePath: path.join(realCwd, "archive", "renamed.md") });
    expect(fs.readFileSync(path.join(cwd, "archive", "renamed.md"), "utf-8")).toBe("new");

    const trashed = await provider.trash(
      { kind: "local-file", path: "archive/renamed.md" },
      { namespace: "mobile-workbench", metadata: { originalName: "renamed.md", rootId: "default" } },
    );
    expect(trashed.trashId).toMatch(/^trash_/);
    expect(trashed.payloadPath).toBe(path.join(trashRoot, "mobile-workbench", trashed.trashId, "payload"));
    expect(fs.readFileSync(trashed.payloadPath!, "utf-8")).toBe("new");
    expect(JSON.parse(fs.readFileSync(path.join(trashRoot, "mobile-workbench", trashed.trashId, "metadata.json"), "utf-8")))
      .toMatchObject({ originalName: "renamed.md", rootId: "default" });
    expect(fs.existsSync(path.join(cwd, "archive", "renamed.md"))).toBe(false);
  });
});

function makeProviderWithPolicy() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resource-local-fs-policy-"));
  const cwd = path.join(tempRoot, "workspace");
  const agentDir = path.join(tempRoot, "hana-home", "agents", "hana");
  const hanakoHome = path.join(tempRoot, "hana-home");
  const trashRoot = path.join(tempRoot, "trash");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const guard = new ResourceAccessPolicy({
    cwd,
    agentDir,
    workspace: cwd,
    workspaceFolders: [cwd],
    hanakoHome,
    getSandboxEnabled: () => true,
  });
  return {
    cwd,
    provider: new LocalFsProvider({ cwd, guard, trashRoot }),
  };
}
