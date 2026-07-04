/**
 * Minimal Notion board client for bridge self-scan (fetch-based, no SDK).
 *
 * The bridge queries the Build Board directly so cards are picked up within
 * seconds of the Mac being awake, instead of waiting for the cloud agent's
 * 4-hour pulse. The cloud agent stays as the redundant path — both share the
 * same job store, so page-UUID idempotency prevents double dispatch.
 *
 * The BoardClient interface is what the bridge consumes; tests inject fakes.
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

export interface BoardCard {
  pageId: string;
  taskId: string;
  status: string;
  repoPath: string;
  codingAgent: string;
  brief: string;
  verifyCommand?: string;
  /** Raw value of the board's Mode select (mapped to auto/accept_edits via board-map.json). */
  mode?: string;
  project?: string;
}

export interface BoardClient {
  /** Cards currently in any of the given statuses. */
  fetchCards(statuses: string[]): Promise<BoardCard[]>;
  setStatus(pageId: string, status: string): Promise<void>;
  comment(pageId: string, text: string): Promise<void>;
  /** Current board status of one card (null if unreadable). */
  getStatus(pageId: string): Promise<string | null>;
}

export interface BoardPropMap {
  status: string;   // status property (default "Status")
  taskId: string;   // short ID (default "Task ID")
  repo: string;     // repo path (default "Repo Path")
  agent: string;    // coding agent (default "Coding Agent")
  brief: string;    // work brief (default "Brief")
  verify: string;   // verify command (default "Verify Command")
  mode: string;     // execution mode select (default "Mode")
  project: string;  // project relation/select (default "Project")
}

export const DEFAULT_PROP_MAP: BoardPropMap = {
  status: "Status", taskId: "Task ID", repo: "Repo Path",
  agent: "Coding Agent", brief: "Brief", verify: "Verify Command",
  mode: "Mode", project: "Project",
};

/** Resolve a token value; "keychain:<service>" pulls from the macOS Keychain so the secret never sits in plaintext config. */
export async function resolveSecret(value: string): Promise<string> {
  if (!value.startsWith("keychain:")) return value;
  const service = value.slice("keychain:".length);
  const { stdout } = await execFileP("security", ["find-generic-password", "-s", service, "-w"]);
  return stdout.trim();
}

const NOTION_VERSION = "2025-09-03";

/** Best-effort plain-text extraction from any Notion property type. */
function plain(prop: any): string {
  if (!prop) return "";
  switch (prop.type) {
    case "title": return (prop.title ?? []).map((t: any) => t.plain_text).join("");
    case "rich_text": return (prop.rich_text ?? []).map((t: any) => t.plain_text).join("");
    case "status": return prop.status?.name ?? "";
    case "select": return prop.select?.name ?? "";
    case "url": return prop.url ?? "";
    case "unique_id": return prop.unique_id ? `${prop.unique_id.prefix ? prop.unique_id.prefix + "-" : ""}${prop.unique_id.number}` : "";
    case "number": return prop.number != null ? String(prop.number) : "";
    default: return "";
  }
}

export function createNotionBoardClient(token: string, dataSourceId: string, props: BoardPropMap = DEFAULT_PROP_MAP): BoardClient {
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  async function api(method: string, path: string, body?: any): Promise<any> {
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Notion API ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  function toCard(page: any): BoardCard | null {
    const p = page.properties ?? {};
    const taskId = plain(p[props.taskId]);
    if (!taskId) return null; // a card the bridge can't identify is skipped, never guessed
    return {
      pageId: page.id,
      taskId,
      status: plain(p[props.status]),
      repoPath: plain(p[props.repo]),
      codingAgent: plain(p[props.agent]),
      brief: plain(p[props.brief]),
      verifyCommand: plain(p[props.verify]) || undefined,
      mode: plain(p[props.mode]) || undefined,
      project: plain(p[props.project]) || undefined,
    };
  }

  return {
    async fetchCards(statuses) {
      const cards: BoardCard[] = [];
      let cursor: string | undefined;
      do {
        const body: any = {
          filter: { or: statuses.map(s => ({ property: props.status, status: { equals: s } })) },
          ...(cursor ? { start_cursor: cursor } : {}),
        };
        const data = await api("POST", `/data_sources/${dataSourceId}/query`, body);
        for (const page of data.results ?? []) {
          const card = toCard(page);
          if (card) cards.push(card);
        }
        cursor = data.has_more ? data.next_cursor : undefined;
      } while (cursor);
      return cards;
    },
    async setStatus(pageId, status) {
      await api("PATCH", `/pages/${pageId}`, { properties: { [props.status]: { status: { name: status } } } });
    },
    async comment(pageId, text) {
      await api("POST", "/comments", { parent: { page_id: pageId }, rich_text: [{ text: { content: text.slice(0, 1900) } }] });
    },
    async getStatus(pageId) {
      try {
        const page = await api("GET", `/pages/${pageId}`);
        return plain(page.properties?.[props.status]) || null;
      } catch {
        return null;
      }
    },
  };
}
