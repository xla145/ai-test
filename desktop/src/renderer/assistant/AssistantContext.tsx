import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AssistantMode, AssistantReference } from "../../shared/assistant";
import { acceptsContext, freezeReferences } from "./assistantView";
import "./AssistantPanel.css";

export interface AssistantPageContext {
  projectId: string;
  page: string;
  env?: string;
  references: AssistantReference[];
}
export interface AssistantAskInput extends AssistantPageContext {
  text?: string;
  mode?: AssistantMode;
}
export interface AssistantContextValue {
  current: AssistantPageContext | undefined;
  /** Returns an ownership-aware cleanup. Inputs outside App's current project/page are ignored. */
  setPageContext: (input: AssistantPageContext) => () => void;
  /** Publishes a draft and asks the host Dock to open. Does not send a model request. */
  request: (input: AssistantAskInput) => boolean;
  requestAsk: (input: AssistantAskInput) => boolean;
  requestVersion: number;
  draftRequest: AssistantAskInput | undefined;
  clearRequest: (version: number) => void;
}
const Context = createContext<AssistantContextValue | undefined>(undefined);
const copyInput = <T extends AssistantPageContext>(input: T): T => ({ ...input, references: freezeReferences(input.references) });

/** Mount once around both pages and the Dock; projectId/page must come from App, not a kept-alive page. */
export function AssistantProvider({ projectId, page, children }: { projectId: string | undefined; page: string; children: ReactNode }) {
  const active = useRef({ projectId, page });
  active.current = { projectId, page };
  const [publication, setPublication] = useState<{ owner: symbol; input: AssistantPageContext }>();
  const [requestState, setRequestState] = useState<{ version: number; input?: AssistantAskInput }>({ version: 0 });
  const version = useRef(0);
  const setPageContext = useCallback((input: AssistantPageContext) => {
    if (!acceptsContext(active.current, input)) return () => {};
    const owner = Symbol("assistant-page");
    setPublication({ owner, input: copyInput(input) });
    return () => setPublication(previous => previous?.owner === owner ? undefined : previous);
  }, [projectId, page]);
  const request = useCallback((input: AssistantAskInput) => {
    if (!acceptsContext(active.current, input)) return false;
    setRequestState({ version: ++version.current, input: copyInput(input) });
    return true;
  }, []);
  const clearRequest = useCallback((requestVersion: number) => {
    setRequestState(previous => previous.version === requestVersion ? { version: previous.version } : previous);
  }, []);
  useEffect(() => {
    // Do not clear a newly mounted page's publication/request during the same commit.
    const matches = (input: AssistantPageContext) => acceptsContext({ projectId, page }, input);
    setPublication(previous => previous && !matches(previous.input) ? undefined : previous);
    setRequestState(previous => previous.input && !matches(previous.input) ? { version: previous.version } : previous);
  }, [projectId, page]);
  const current = publication && acceptsContext({ projectId, page }, publication.input) ? publication.input : undefined;
  const draftRequest = requestState.input && acceptsContext({ projectId, page }, requestState.input) ? requestState.input : undefined;
  const value = useMemo<AssistantContextValue>(() => ({ current, setPageContext, request, requestAsk: request,
    requestVersion: requestState.version, draftRequest, clearRequest }), [current, setPageContext, request, requestState.version, draftRequest, clearRequest]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useAssistantContext(): AssistantContextValue {
  const value = useContext(Context);
  if (!value) throw new Error("助手组件需要放在 AssistantProvider 中");
  return value;
}

/** Safe for kept-alive pages; changing the selection republishes a detached copy. */
export function useAssistantPageContext(input: AssistantPageContext): void {
  const { setPageContext } = useAssistantContext();
  const referencesJson = JSON.stringify(input.references);
  useEffect(() => setPageContext({ projectId: input.projectId, page: input.page, env: input.env,
    references: JSON.parse(referencesJson) as AssistantReference[] }), [setPageContext, input.projectId, input.page, input.env, referencesJson]);
}

export interface AssistantAskButtonProps extends AssistantAskInput {
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}
export function AssistantAskButton({ children = "问助手", className, disabled, "aria-label": label = "引用当前内容询问助手", ...input }: AssistantAskButtonProps) {
  const { request } = useAssistantContext();
  return <button type="button" className={className ?? "assistant-ask-button"} disabled={disabled} aria-label={label}
    onClick={() => request(input)}>{children}</button>;
}
