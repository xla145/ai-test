import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import type { TaskSnapshot } from "../../shared/taskProgress";
import { api } from "../api";
import { subscribe } from "../bridge";
export const emptyTasks: TaskSnapshot = { revision: -1, tasks: [] };
export function taskReducer(state: TaskSnapshot, next: TaskSnapshot): TaskSnapshot {
  return next && Number.isFinite(next.revision) && Array.isArray(next.tasks) && next.revision > state.revision ? next : state;
}
const Context = createContext<TaskSnapshot>(emptyTasks);
export const useTasks = () => useContext(Context).tasks;
export function TaskProvider({ children }: { children: ReactNode }) {
  const [state, sync] = useReducer(taskReducer, emptyTasks);
  useEffect(() => {
    let disposed = false, pending = false;
    const off = subscribe("event", event => { if (event.method === "aitest/task-records") sync(event.params as TaskSnapshot); });
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try { const value = await api().taskSnapshot(); if (!disposed) sync(value); }
      catch { /* a later snapshot repairs missing events */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => { disposed = true; off(); clearInterval(timer); };
  }, []);
  return <Context.Provider value={state}>{children}</Context.Provider>;
}
