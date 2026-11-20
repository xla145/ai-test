import type { AitestApi, ApprovalRequest, UpdateState } from "../shared/ipc";

export interface BridgeEvents {
  event: { method: string; params: unknown };
  approval: ApprovalRequest;
  view: { visible: boolean; docked?: boolean; shown?: boolean };
  update: UpdateState;
}
type Listener<T> = (value: T) => void;
const subscriptions = { onEvent: "event", onApprovalRequest: "approval", onViewChange: "view", onUpdate: "update" } as const;
const reads = new Set<string>([
  "assistantConversations", "assistantConversation",
  "listProjects", "listCases", "pageCases", "pageIssues", "listRoles", "roleSecretStatus", "getSettings", "getSettingsDetail",
  "getGlobalSettings", "getUserInfo", "uiTasks", "taskSnapshot", "taskProgress", "listApiDefinitions", "listApiTestSets",
  "performanceHistory", "perfGetBaseline", "perfTrend", "listRuns", "runDetail", "caseTitles", "scriptMap", "uiScriptStates",
]);
export function ipcError(error: unknown): Error {
  const normalized = new Error(String(error instanceof Error ? error.message : error)
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  normalized.name = error instanceof Error ? error.name : "Error";
  return normalized;
}

/** A single safe preload subscription per event; never reaches into Electron from the renderer. */
export function createBridge(host: AitestApi) {
  const listeners = new Map<keyof BridgeEvents, Set<Listener<any>>>();
  const cleanups = new Map<keyof BridgeEvents, () => void>();
  const inflight = new Map<string, Promise<unknown>>();
  const counts = new Set<Listener<number>>();
  let active = 0;
  const publishCount = () => { for (const cb of counts) { try { cb(active); } catch { /* isolate observers */ } } };
  const subscribe = <K extends keyof BridgeEvents>(kind: K, callback: Listener<BridgeEvents[K]>): (() => void) => {
    const set = listeners.get(kind) ?? new Set();
    listeners.set(kind, set); set.add(callback);
    if (!cleanups.has(kind)) {
      const method = Object.entries(subscriptions).find(([, value]) => value === kind)![0] as keyof typeof subscriptions;
      const source = host[method] as ((cb: Listener<any>) => () => void) | undefined;
      if (source) cleanups.set(kind, source.call(host, value => {
        for (const cb of [...(listeners.get(kind) ?? [])]) { try { cb(value); } catch { /* one consumer cannot break others */ } }
      }));
    }
    return () => {
      set.delete(callback);
      if (!set.size) { cleanups.get(kind)?.(); cleanups.delete(kind); listeners.delete(kind); }
    };
  };
  const methods = new Map<PropertyKey, unknown>();
  const api = new Proxy({} as AitestApi, {
    get: (_, key) => {
      if (methods.has(key)) return methods.get(key);
      const raw = host[key as keyof AitestApi];
      if (typeof raw !== "function") return raw;
      const kind = subscriptions[key as keyof typeof subscriptions];
      const wrapped = kind ? (cb: Listener<any>) => subscribe(kind, cb)
        : key === "respondApproval" ? (...args: unknown[]) => (raw as Function).apply(host, args)
        : (...args: unknown[]) => {
          let cacheKey: string | undefined;
          if (reads.has(String(key))) { try { cacheKey = JSON.stringify([key, args]); } catch { /* non-JSON arguments: do not dedupe */ } }
          if (cacheKey && inflight.has(cacheKey)) return inflight.get(cacheKey);
          active++; publishCount();
          const call = () => Promise.resolve().then(() => (raw as Function).apply(host, args));
          const promise = call().catch(error => {
            // Only a positively identified transport failure is safe to retry, and only for reads.
            if (cacheKey && error?.code === "IPC_DISCONNECTED") return call();
            throw error;
          }).catch(error => { throw ipcError(error); }).finally(() => {
            if (cacheKey) inflight.delete(cacheKey);
            active--; publishCount();
          });
          if (cacheKey) inflight.set(cacheKey, promise);
          return promise;
        };
      methods.set(key, wrapped); return wrapped;
    },
  });
  return { api, subscribe, get activeCount() { return active; },
    onInflight(cb: Listener<number>) { counts.add(cb); cb(active); return () => { counts.delete(cb); }; },
    dispose() { for (const off of cleanups.values()) off(); cleanups.clear(); listeners.clear(); counts.clear(); },
  };
}
let singleton: ReturnType<typeof createBridge> | undefined;
let source: AitestApi | undefined;
function bridge() {
  if (source !== window.aitest) { singleton?.dispose(); source = window.aitest; singleton = createBridge(source); }
  return singleton!;
}
export const api = (): AitestApi => bridge().api;
export const subscribe = <K extends keyof BridgeEvents>(kind: K, callback: Listener<BridgeEvents[K]>) => bridge().subscribe(kind, callback);
