import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { atomicWriteSync } from "../shared/safe-fs.ts";

const CHECKPOINT_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

function assertSafeCheckpointId(id: string): string {
  if (!CHECKPOINT_ID_RE.test(id)) {
    throw new Error("invalid checkpoint id");
  }
  return id;
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".wasm",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".flac",
  ".ttf", ".otf", ".woff", ".woff2",
  ".db", ".sqlite", ".sqlite3",
]);

export class CheckpointStore {
  declare _dir: string;

  constructor(checkpointsDir: string) {
    this._dir = checkpointsDir;
  }

  async save({ sessionPath, tool, filePath, maxSizeKb, source, reason }: { sessionPath: string; tool: string; filePath: string; maxSizeKb: number; source: string; reason: string }) {
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return null;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }

    if (!stat.isFile() || stat.size > maxSizeKb * 1024) return null;

    const buf = fs.readFileSync(filePath);
    const sample = buf.subarray(0, 8192);
    if (sample.includes(0)) return null;

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      // Unknown binary formats must not be saved as replacement-corrupted text.
      return null;
    }

    fs.mkdirSync(this._dir, { recursive: true });
    const ts = Date.now();
    const suffix = randomBytes(2).toString("hex");
    const id = `${ts}_${suffix}`;
    const filename = `${id}.json`;
    const fileFull = path.join(this._dir, filename);

    const data = JSON.stringify({
      ts,
      sessionPath: sessionPath || null,
      tool,
      source: source || "llm",
      reason: reason || `tool-${tool}`,
      path: filePath,
      resolvedParentPath: fs.realpathSync(path.dirname(filePath)),
      content,
      size: stat.size,
    });

    atomicWriteSync(fileFull, data);

    return id;
  }

  async list() {
    let entries;
    try {
      entries = fs.readdirSync(this._dir);
    } catch {
      return [];
    }

    const results = [];
    for (const name of entries) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
      try {
        const raw = fs.readFileSync(path.join(this._dir, name), "utf-8");
        const obj = JSON.parse(raw);
        results.push({
          id: name.replace(/\.json$/, ""),
          ts: obj.ts,
          tool: obj.tool,
          source: obj.source || "llm",
          reason: obj.reason || `tool-${obj.tool}`,
          path: obj.path,
          size: obj.size,
        });
      } catch {
        // corrupted file, skip
      }
    }

    results.sort((a, b) => b.ts - a.ts);
    return results;
  }

  async restore(id: string) {
    const safeId = assertSafeCheckpointId(id);
    const filePath = path.join(this._dir, `${safeId}.json`);
    const raw = fs.readFileSync(filePath, "utf-8");
    const obj = JSON.parse(raw);
    if (typeof obj.path !== "string" || !path.isAbsolute(obj.path)) {
      throw new Error("checkpoint target path must be absolute");
    }
    if (typeof obj.content !== "string") {
      throw new Error("checkpoint content must be text");
    }

    try {
      if (fs.lstatSync(obj.path).isSymbolicLink()) {
        throw new Error("checkpoint restore refuses to write through a symbolic link");
      }
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }

    fs.mkdirSync(path.dirname(obj.path), { recursive: true });
    // Pin the canonical target parent at save time: if a directory is replaced
    // by a symlink after the checkpoint was captured, never redirect restore.
    // Older checkpoints without this field retain their legacy restore behavior.
    if (obj.resolvedParentPath
      && fs.realpathSync(path.dirname(obj.path)) !== obj.resolvedParentPath) {
      throw new Error("checkpoint target directory changed since backup");
    }
    // Write the replacement completely in the same directory before swapping
    // it into place. A write/fsync failure must leave the original untouched.
    // wx and an unpredictable name also prevent colliding with another restore.
    const targetMode = (() => {
      try { return fs.lstatSync(obj.path).mode & 0o777; }
      catch (err) {
        if (err?.code === "ENOENT") return 0o600;
        throw err;
      }
    })();
    const tempPath = path.join(
      path.dirname(obj.path),
      `.${path.basename(obj.path)}.checkpoint-${randomBytes(8).toString("hex")}.tmp`,
    );
    let fd: number | null = null;
    try {
      fd = fs.openSync(tempPath, "wx", targetMode);
      fs.writeFileSync(fd, obj.content, "utf-8");
      fs.fchmodSync(fd, targetMode);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, obj.path);
    } finally {
      if (fd != null) fs.closeSync(fd);
      try { fs.unlinkSync(tempPath); } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    }

    return { restoredTo: obj.path };
  }

  async remove(id: string) {
    const safeId = assertSafeCheckpointId(id);
    const filePath = path.join(this._dir, `${safeId}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  async cleanup(retentionDays: number) {
    let entries;
    try {
      entries = fs.readdirSync(this._dir);
    } catch {
      return;
    }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const name of entries) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
      const ts = parseInt(name.split("_")[0], 10);
      if (!isNaN(ts) && ts < cutoff) {
        try {
          fs.unlinkSync(path.join(this._dir, name));
        } catch {}
      }
    }
  }
}
