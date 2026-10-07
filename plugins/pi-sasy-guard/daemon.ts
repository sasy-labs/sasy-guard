// The sasy-watch daemon, as the pi extension reaches it: a loopback HTTP
// service started by `sasy-guard install`. Every POST carries the hook token
// the daemon writes to its home after it starts.
import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORT = 51711;
const CHECK_TIMEOUT_MS = 12_000;
const ENSURE_WAIT_MS = 6_000;
const AUTH_HEADER = "x-sasy-hook-token";

export interface DaemonOptions {
  env?: NodeJS.ProcessEnv;
}

/** Why a request got no answer from the daemon. */
export class DaemonUnavailable extends Error {}

export class DaemonClient {
  readonly home: string;
  readonly port: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: DaemonOptions = {}) {
    this.env = opts.env ?? process.env;
    this.home = this.env.SASY_HOME || join(homedir(), ".sasy");
    const port = Number(this.env.SASY_WATCH_PORT || DEFAULT_PORT);
    this.port = Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * The hook token, read as the daemon's own hooks read it: a regular file
   * owned by this user and readable by no one else. Undefined when absent or
   * not secure (the daemon is not running, or the file cannot be trusted).
   */
  token(): string | undefined {
    const path = join(this.home, `hook-auth-${this.port}.header`);
    try {
      const st = lstatSync(path);
      if (!st.isFile() || (st.mode & 0o077) !== 0) return undefined;
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) return undefined;
      const line = readFileSync(path, "utf8").trim();
      const prefix = `${AUTH_HEADER}:`;
      if (!line.toLowerCase().startsWith(prefix)) return undefined;
      const value = line.slice(prefix.length).trim();
      return /^[0-9a-f]{64}$/.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** One POST; the parsed JSON answer. Throws DaemonUnavailable on any failure. */
  async post(path: string, body: unknown, timeoutMs = CHECK_TIMEOUT_MS): Promise<unknown> {
    // The daemon writes its token when it starts and requires it on every
    // request; without one, whatever answers on the port is not trusted, and
    // the daemon is treated as not running (so postEnsuring starts it).
    const token = this.token();
    if (!token) throw new DaemonUnavailable(`sasy-watch unreachable on port ${this.port} (no hook token)`);
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", [AUTH_HEADER]: token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DaemonUnavailable(`sasy-watch unreachable on port ${this.port} (${(err as Error).message})`);
    }
    if (!res.ok) throw new DaemonUnavailable(`sasy-watch answered HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new DaemonUnavailable("sasy-watch gave an answer that is not JSON");
    }
  }

  /** POSTs, and when the daemon does not answer, starts it once and retries. */
  async postEnsuring(path: string, body: unknown): Promise<unknown> {
    try {
      return await this.post(path, body);
    } catch (err) {
      if (!(err instanceof DaemonUnavailable) || !/unreachable/.test(err.message)) throw err;
      await this.ensure();
      return this.post(path, body);
    }
  }

  /** Starts the daemon if it is down (`sasy-watch ensure`), as the hook scripts do. */
  ensure(): Promise<void> {
    const bin = this.env.SASY_WATCH_BIN || join(this.home, "bin", "sasy-watch");
    return new Promise((resolve) => {
      execFile(bin, ["ensure", "--wait-ms", String(ENSURE_WAIT_MS)], { timeout: ENSURE_WAIT_MS + 4_000, env: this.env }, () => resolve());
    });
  }

  /** One line on daemon health for /guard, from GET /healthz. */
  async health(): Promise<string> {
    try {
      const res = await fetch(`${this.base}/healthz`, { signal: AbortSignal.timeout(3_000) });
      if (res.status !== 200) return `daemon: ${this.base}/healthz answered HTTP ${res.status}`;
      const h = (await res.json()) as Record<string, unknown>;
      const endpointOk = typeof h.endpoint === "string" && /^[A-Za-z0-9.:[\]_-]{1,255}$/.test(h.endpoint);
      const failOk = h.failMode === "open" || h.failMode === "closed";
      if (h.ok !== true || !endpointOk || !failOk || !Number.isInteger(h.sessions)) {
        return `daemon: ${this.base}/healthz answered, but not as the sasy-watch daemon`;
      }
      const state = h.ready === true ? "up, policy engine ready" : "up, policy engine not ready";
      return `daemon: ${state} · endpoint ${h.endpoint} · fail mode ${h.failMode} · ${h.sessions} session(s)`;
    } catch (err) {
      return `daemon: unreachable at ${this.base} (${(err as Error).message})`;
    }
  }
}
