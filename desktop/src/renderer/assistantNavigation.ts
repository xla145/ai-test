import { useEffect, useRef } from "react";
import type { AssistantReference } from "../shared/assistant";

const pending = new Map<string, AssistantReference>();
const EVENT = "aitest:assistant-navigation";
export function navigateAssistantReference(projectId: string, reference: AssistantReference, go: (page: string) => void) {
  const page = { case: "cases", definition: "api", run: "reports" }[reference.kind];
  pending.set(`${projectId}:${page}`, reference);
  go(page);
  window.dispatchEvent(new Event(EVENT));
}
export function useAssistantNavigation(projectId: string, page: string, ready: boolean, open: (reference: AssistantReference) => void) {
  const callback = useRef(open);
  callback.current = open;
  useEffect(() => {
    if (!ready) return;
    const take = () => {
      const key = `${projectId}:${page}`;
      const ref = pending.get(key);
      if (!ref) return;
      pending.delete(key); callback.current(ref);
    };
    take(); window.addEventListener(EVENT, take);
    return () => window.removeEventListener(EVENT, take);
  }, [projectId, page, ready]);
}
