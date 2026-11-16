export interface PerformanceOptions {
  path: string;
  vus: number;
  seconds: number;
  p95Ms: number;
  maxFailureRate: number;
}
export interface PerformanceResult {
  id: string;
  env: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed" | "stopped" | "error";
  options: PerformanceOptions;
  requests: number | null;
  requestsPerSecond: number | null;
  failureRate: number | null;
  p95Ms: number | null;
  thresholdsPassed: boolean;
  message?: string;
  reportPath: string;
}
