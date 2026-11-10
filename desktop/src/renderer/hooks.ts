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
