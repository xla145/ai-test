import type { ProjectType } from "../shared/ipc";

export const projectTypeOptions: { value: ProjectType; label: string }[] = [
  { value: "web", label: "Web" },
  { value: "app", label: "App" },
  { value: "api", label: "纯接口" },
  { value: "multi", label: "多端（Web + App）" },
];

export function visibleProjectTab(key: string, type: ProjectType = "multi"): boolean {
  if (key === "ui") return type === "web" || type === "multi";
  if (key === "app") return type === "app" || type === "multi";
  return true;
}
