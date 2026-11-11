import { App } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

/** 执行一个操作：处理中状态 + 统一的成功 / 失败提示 */
export function useAction() {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const out = await fn();
        if (success) message.success(success);
        return out;
      } catch (e) {
        message.error({ content: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), duration: 6 });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [message],
  );
  return { busy, run };
}

/** 多个操作共用互斥锁，但只有当前操作的按钮显示加载状态。 */
export function useKeyedAction() {
  const { run } = useAction();
  const [activeKey, setActiveKey] = useState<string>();
  const activeRef = useRef<string>();
  const runKeyed = useCallback(async <T,>(key: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    if (activeRef.current !== undefined) return undefined;
    activeRef.current = key;
    setActiveKey(key);
    try {
      return await run(fn, success);
    } finally {
      activeRef.current = undefined;
      setActiveKey(undefined);
    }
  }, [run]);
  return { activeKey, busy: activeKey !== undefined, run: runKeyed };
}

/** 加载数据：依赖变化时重新加载，返回 reload */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fnRef.current());
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => void reload(), [reload]);
  return { data, loading, reload, setData };
}

export interface PageData<T> {
  items: T[];
  total: number;
  levels?: Record<string, number>;
}

/**
 * 服务端分页：按页向引擎取数，返回可直接传给 antd Table / List 的 pagination。
 * - deps（项目、筛选条件等）变化时回到第 1 页；
 * - 处理完当前页最后一条（如审核、合并后）自动退回上一页。
 */
export function usePaged<T>(
  fetch: (q: { page: number; pageSize: number }) => Promise<PageData<T>>,
  deps: unknown[],
  defaultPageSize = 20,
) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [data, setData] = useState<PageData<T>>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const seq = useRef(0);
  const key = JSON.stringify(deps);
  const [lastKey, setLastKey] = useState(key);
  // 条件变化：同步回到第 1 页，避免先用旧页码请求一次
  const current = key === lastKey ? page : 1;
  if (key !== lastKey) {
    setLastKey(key);
    setPage(1);
  }

  const load = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const out = await fetchRef.current({ page: current, pageSize });
      if (id !== seq.current) return; // 已有更新的请求
      if (!out.items.length && out.total > 0 && current > 1) {
        setPage(Math.max(1, Math.ceil(out.total / pageSize)));
        return;
      }
      setData(out);
    } finally {
      if (id === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, pageSize, key]);
  useEffect(() => void load(), [load]);

  const pagination = {
    current,
    pageSize,
    total: data.total,
    showSizeChanger: true,
    pageSizeOptions: [10, 20, 50, 100],
    showTotal: (t: number) => `共 ${t} 条`,
    onChange: (p: number, size: number) => {
      if (size !== pageSize) {
        setPageSize(size);
        setPage(1);
      } else setPage(p);
    },
  };
  return { ...data, loading, reload: load, pagination };
}

/** 输入框防抖：用于搜索条件，避免每次按键都请求引擎 */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** 容器宽度低于阈值时返回 true（内嵌浏览器打开后内容区只有半屏，按容器而不是窗口判断）。
 *  返回回调 ref：容器晚于首次渲染出现（如先显示加载状态）也能开始监听 */
export function useNarrow<T extends HTMLElement>(threshold = 760) {
  const [el, setEl] = useState<T | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < threshold));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, threshold]);
  return [setEl, narrow] as const;
}

const PROJECT_CHANGED = "aitest:project-changed";

/** 用例、执行记录等变化后通知（如「快速开始」据此刷新进度） */
export function notifyProjectChanged(projectId: string) {
  window.dispatchEvent(new CustomEvent(PROJECT_CHANGED, { detail: projectId }));
}

/** 订阅某个项目的数据变化 */
export function useProjectChanged(projectId: string, cb: () => void) {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === projectId) cbRef.current();
    };
    window.addEventListener(PROJECT_CHANGED, on);
    return () => window.removeEventListener(PROJECT_CHANGED, on);
  }, [projectId]);
}
