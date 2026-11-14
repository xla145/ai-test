import { ArrowRightOutlined, CheckOutlined } from "@ant-design/icons";
import { Tooltip } from "antd";

export interface WorkflowStep {
  title: string;
  description: string;
  done?: boolean;
}

/** 头部指导流程：标题常显，详细说明同时支持悬停和键盘聚焦。 */
export function WorkflowGuide({ steps, label = "操作流程", current, onStepClick }: {
  steps: WorkflowStep[];
  label?: string;
  current?: number;
  onStepClick?: (index: number) => void;
}) {
  return (
    <ol className="workflow-guide" aria-label={label}>
      {steps.map((step, i) => {
        const content = <>
          <span className="workflow-index">{step.done ? <CheckOutlined /> : i + 1}</span>
          <span>{step.title}</span>
        </>;
        return (
          <li key={step.title} className={`${i === current ? "is-current" : ""} ${step.done ? "is-done" : ""}`}>
            <Tooltip title={step.description}>
              {onStepClick ? (
                <button type="button" className="workflow-step" aria-current={i === current ? "step" : undefined}
                  aria-label={`${step.title}：${step.description}`} onClick={() => onStepClick(i)}>{content}</button>
              ) : (
                <span className="workflow-step" tabIndex={0} aria-label={`${step.title}：${step.description}`}>{content}</span>
              )}
            </Tooltip>
            {i < steps.length - 1 && <ArrowRightOutlined className="workflow-arrow" />}
          </li>
        );
      })}
    </ol>
  );
}
