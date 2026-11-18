import { CaretRightFilled, CheckCircleFilled, CloseCircleFilled, LoadingOutlined, MinusCircleOutlined, StopOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Segmented, Tag, Tooltip, Typography } from "antd";
import React, { useEffect, useMemo, useState } from "react";
import type { UiScriptDetail, UiStepView } from "../../shared/ipc";

export interface StepRunState { status: "running" | "passed" | "failed" | "skipped"; error?: string; note?: string }

/** 单步调试时的交互：断点、游标、运行到此 / 从此步开始 */
export interface StepDebug {
  cursor?: string;
  breakpoints: string[];
  running: boolean;
  onBreakpoint: (id: string) => void;
  onRunTo: (id: string) => void;
  onSeek: (id: string) => void;
}

const ACTION_KIND: Record<string, { label: string; color?: string }> = {
  goto: { label: "打开" }, click: { label: "点击" }, fill: { label: "输入" }, select: { label: "选择" }, check: { label: "勾选" },
  press: { label: "按键" }, startCapture: { label: "捕获" }, installClock: { label: "时钟" }, fastForward: { label: "时钟" },
  expectVisible: { label: "断言", color: "blue" }, expectHidden: { label: "断言", color: "blue" }, expectText: { label: "断言", color: "blue" }, expectNoText: { label: "断言", color: "blue" }, expectValue: { label: "断言", color: "blue" },
  expectUrl: { label: "断言", color: "blue" }, expectRequest: { label: "断言", color: "blue" }, expectDb: { label: "断言", color: "blue" },
  readValue: { label: "读取" }, reveal: { label: "显示区域" }, expectNumber: { label: "数值断言", color: "blue" }, expectObserved: { label: "值比较", color: "blue" },
  visualCheck: { label: "复核", color: "purple" },
};

/** 原始用例常带「【1】1.」这类文档编号，界面已有自己的层级编号，展示时只去掉重复前缀。 */
function displayText(value: string): string {
  return value.replace(/^\s*【\s*\d+\s*】\s*/, "").replace(/^\s*\d+\s*[.、](?!\d)\s*/, "").trim();
}

function StatusIcon({ state }: { state?: StepRunState }) {
  if (!state) return <MinusCircleOutlined className="step-icon idle" />;
  if (state.status === "running") return <LoadingOutlined className="step-icon running" />;
  if (state.status === "passed") return <CheckCircleFilled className="step-icon passed" />;
  if (state.status === "skipped") return <StopOutlined className="step-icon skipped" />;
  return <CloseCircleFilled className="step-icon failed" />;
}

function StepRow({ step, state, multiRole, debug, showMapping = true }: { step: UiStepView; state?: StepRunState; multiRole: boolean; debug?: StepDebug; showMapping?: boolean }) {
  const kind = ACTION_KIND[step.action] ?? { label: step.action };
  const atCursor = debug?.cursor === step.id;
  const breakpoint = debug?.breakpoints.includes(step.id);
  return (
    <div className={`script-step ${state?.status ?? ""} ${atCursor ? "cursor" : ""}`} data-step={step.id}>
      {debug && (
        <Tooltip title={breakpoint ? "取消断点" : "设置断点：连续执行到这一步前停下"} placement="left">
          <button type="button" className={`step-breakpoint ${breakpoint ? "on" : ""}`} aria-label={`${step.id} 断点`}
            onClick={() => debug.onBreakpoint(step.id)} />
        </Tooltip>
      )}
      {atCursor && !debug?.running && state?.status !== "failed" ? <CaretRightFilled className="step-icon cursor" /> : <StatusIcon state={state} />}
      <span className="script-step-id mono">{step.id}</span>
      <div className="script-step-body">
        <div>
          <Tag bordered={false} color={kind.color} style={{ marginInlineEnd: 6 }}>{kind.label}</Tag>
          <Typography.Text delete={state?.status === "skipped"}>{step.description}</Typography.Text>
          {multiRole && step.role && <Tag bordered={false} style={{ marginInlineStart: 6 }}>{step.role}</Tag>}
          {step.source && step.source !== "ai" && <Tooltip title="人工补充或修正的步骤"><Tag bordered={false} color="gold" style={{ marginInlineStart: 6 }}>人工</Tag></Tooltip>}
        </div>
        {showMapping && (step.expectedIndices?.length || step.preconditionIndices?.length) ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {step.expectedIndices?.length ? `预期 ${step.expectedIndices.join("、")}` : ""} {step.preconditionIndices?.length ? `前置条件 ${step.preconditionIndices.join("、")}` : ""}
        </Typography.Text> : null}
        {state?.note && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{state.note}</Typography.Text>}
        {state?.status === "failed" && state.error && (
          <Typography.Paragraph type="danger" className="mono" style={{ margin: "4px 0 0", fontSize: 12 }}
            ellipsis={{ rows: 3, expandable: true, symbol: "展开" }}>{state.error}</Typography.Paragraph>
        )}
      </div>
      {debug && !debug.running && (
        <div className="script-step-actions">
          <Tooltip title="从当前位置连续执行到这一步（含）"><Button size="small" type="link" onClick={() => debug.onRunTo(step.id)}>运行到此</Button></Tooltip>
          <Tooltip title="把执行位置移到这一步，不执行前面的步骤（页面需已在对应状态）"><Button size="small" type="link" onClick={() => debug.onSeek(step.id)}>从此开始</Button></Tooltip>
        </div>
      )}
    </div>
  );
}

/**
 * 脚本步骤与用例步骤对照：按用例步骤分组，执行时显示每步状态；
 * 没有对应脚本步骤的用例步骤会被标出，便于发现漏掉的操作或断言。
 */
export function ScriptSteps({ caseSteps, expected, preconditions = [], detail, states, debug }: {
  caseSteps: string[];
  expected: string[];
  preconditions?: string[];
  detail?: UiScriptDetail | null;
  states: Record<string, StepRunState>;
  debug?: StepDebug;
}) {
  const steps = detail?.steps;
  const [view, setView] = useState<"compare" | "steps" | "code">("compare");
  // 旧脚本或脚本被改过时，以代码为准；调试时固定显示步骤
  useEffect(() => { setView(detail && (!steps || !detail.synced) ? "code" : detail ? "compare" : "steps"); }, [detail?.path]);
  useEffect(() => { if (debug && steps) setView("steps"); }, [Boolean(debug), steps]); // eslint-disable-line react-hooks/exhaustive-deps
  // 游标移动时滚动到可见位置
  useEffect(() => {
    if (debug?.cursor) document.querySelector(`.script-step[data-step="${CSS.escape(debug.cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [debug?.cursor]);

  const multiRole = new Set((steps ?? []).map((s) => s.role ?? "default")).size > 1;
  const groups = useMemo(() => {
    const byCase = new Map<number, UiStepView[]>();
    /** 第一个对应用例步骤之前的步骤（如打开页面）放在最前面，其余未对应的放最后 */
    const before: UiStepView[] = [];
    const loose: UiStepView[] = [];
    for (const st of steps ?? []) {
      if (st.caseStep && st.caseStep <= caseSteps.length) byCase.set(st.caseStep, [...(byCase.get(st.caseStep) ?? []), st]);
      else (byCase.size ? loose : before).push(st);
    }
    return { byCase, before, loose };
  }, [steps, caseSteps.length]);
  // 完全没有声明用例步骤（旧录制）时不分组，避免每组都显示“未覆盖”
  const mapped = groups.byCase.size > 0;

  return (
    <div className="script-steps">
      {detail && (
        <div className="script-steps-head">
          <Segmented size="small" value={view} onChange={(v) => setView(v as "compare" | "steps" | "code")}
            options={[{ label: "用例对照", value: "compare", disabled: !steps }, { label: "脚本步骤", value: "steps", disabled: !steps }, { label: "代码", value: "code", disabled: Boolean(debug) }]} />
          <Typography.Text type="secondary" className="mono" ellipsis title={detail.path} style={{ fontSize: 12, minWidth: 0 }}>{detail.path}</Typography.Text>
        </div>
      )}
      {detail && !steps && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="该脚本没有结构化步骤（较早生成），重新生成后可按步骤对照查看" />}
      {detail && steps && !detail.synced && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message="脚本代码已被修改（例如合并了修正建议），步骤列表可能与代码不一致，以代码为准" />
      )}
      {view === "code" && detail ? (
        <pre className="script-code mono">{detail.code}</pre>
      ) : view === "compare" && detail && steps ? (
        <div className="script-compare">
          <Typography.Paragraph type="secondary" className="script-compare-note">关联仅表示脚本声明覆盖；请核对目标、输入与断言值，执行结果以试跑报告为准。</Typography.Paragraph>
          {(!detail.source || JSON.stringify(detail.source.steps ?? []) !== JSON.stringify(caseSteps) || JSON.stringify(detail.source.expected ?? []) !== JSON.stringify(expected) || JSON.stringify(detail.source.preconditions ?? []) !== JSON.stringify(preconditions)) && <Alert type="warning" showIcon message={detail.source ? "用例已变化：以下为历史映射，请重新生成或核对" : "缺少生成时的用例快照：无法确认映射版本"} />}
          <div className="script-compare-head"><span>原始用例</span><span>生成脚本 · 动作与断言</span></div>
          {([
            { label: "前置条件", values: preconditions, field: "preconditionIndices" },
            { label: "步骤", values: caseSteps, field: "caseStep" },
            { label: "预期", values: expected, field: "expectedIndices" },
          ] as const).map(section => <section key={section.field} aria-label={`${section.label}对照`}>
            <div className="script-compare-section"><span>{section.label}</span><span className="script-compare-count">{section.values.length} 项</span></div>
            {!section.values.length && <div className="script-compare-note">未声明{section.label}</div>}
            {section.values.map((text, i) => {
              const own = steps.filter(st => section.field === "caseStep" ? st.caseStep === i + 1 : st[section.field]?.includes(i + 1) && (st.action.startsWith("expect") || st.action === "visualCheck"));
              return <div className="script-compare-row" key={i}>
              <div className="script-compare-source"><div className="script-compare-source-text"><span className="case-group-index">{i + 1}</span><span>{displayText(text)}</span></div>
                  <Tag bordered={false} color={own.length ? "blue" : "orange"}>{own.length ? `已关联 ${own.length} 个${section.field === "caseStep" ? "步骤" : "断言"}` : "未关联"}</Tag>
                </div>
                <div className="script-compare-generated">
                  {!own.length && <Typography.Text type="warning">{section.field === "caseStep" ? "没有对应脚本动作" : "没有能证明此项的关联断言"}</Typography.Text>}
                  {own.map(st => <div key={st.id}>
                    <StepRow step={st} state={states[st.id]} multiRole={multiRole} showMapping={false} />
                    {st.action === "expectObserved" && <Typography.Text type="secondary">不等于验证正确或执行通过</Typography.Text>}
                    {st.action === "visualCheck" && <Typography.Text type="secondary">截图需人工复核</Typography.Text>}
                  </div>)}
                </div>
              </div>;
            })}
          </section>)}
          {steps.some(st => !st.caseStep && !st.expectedIndices?.length && !st.preconditionIndices?.length) && <section aria-label="未关联步骤">
            <div className="script-compare-section">准备 / 未关联步骤 · 请核对必要性</div>
            {steps.filter(st => !st.caseStep && !st.expectedIndices?.length && !st.preconditionIndices?.length).map(st => <StepRow key={st.id} step={st} state={states[st.id]} multiRole={multiRole} showMapping={false} />)}
          </section>}
        </div>
      ) : (
        <>
          {mapped && groups.before.length > 0 && (
            <div className="case-group">
              <div className="case-group-head"><Typography.Text type="secondary">准备步骤</Typography.Text></div>
              {groups.before.map((st) => <StepRow key={st.id} step={st} state={states[st.id]} multiRole={multiRole} debug={debug} />)}
            </div>
          )}
          {caseSteps.map((text, i) => {
            const own = mapped ? groups.byCase.get(i + 1) ?? [] : [];
            return (
              <div key={i} className="case-group">
                <div className="case-group-head">
                  <span className="case-group-index">{i + 1}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div>{displayText(text)}</div>
                    {expected.length === caseSteps.length && <Typography.Text type="secondary" className="case-expected">预期：{displayText(expected[i])}</Typography.Text>}
                  </div>
                  {mapped && !own.length && <Tag bordered={false} color="orange">无对应脚本步骤</Tag>}
                  {mapped && own.length > 0 && !own.some((s) => (ACTION_KIND[s.action]?.color)) && (
                    <Tooltip title="这一步只有操作，没有断言"><Tag bordered={false} color="orange">无断言</Tag></Tooltip>
                  )}
                </div>
                {own.map((st) => <StepRow key={st.id} step={st} state={states[st.id]} multiRole={multiRole} debug={debug} />)}
              </div>
            );
          })}
          {(mapped ? groups.loose : steps ?? []).length > 0 && (
            <div className="case-group">
              <div className="case-group-head"><Typography.Text type="secondary">{mapped ? "未对应用例步骤" : "脚本步骤"}</Typography.Text></div>
              {(mapped ? groups.loose : steps!).map((st) => <StepRow key={st.id} step={st} state={states[st.id]} multiRole={multiRole} debug={debug} />)}
            </div>
          )}
          {expected.length > 0 && expected.length !== caseSteps.length && <div className="case-group">
            <div className="case-group-head">预期结果</div>
            {expected.map((text, i) => <div className="case-expected-item" key={i}><span className="case-group-index">{i + 1}</span><span>{displayText(text)}</span></div>)}
          </div>}
          {!caseSteps.length && !steps?.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="用例没有步骤" />}
        </>
      )}
    </div>
  );
}
