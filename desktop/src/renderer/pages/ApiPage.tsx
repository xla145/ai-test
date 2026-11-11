import { FileTextOutlined, RobotOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Descriptions, Input, Result, Segmented, Space, Steps, Switch, Typography } from "antd";
import { useState } from "react";
import { api, type Project } from "../api";
import { PageHeader } from "../components/PageHeader";
import { useProjects } from "../components/ProjectSettings";
import { useAction, notifyProjectChanged } from "../hooks";

interface SuiteResult {
  generated?: { generated: number };
  suite?: { cases: number; skipped: number; test: string; version?: string };
  agent?: { tokens: number; status: string };
}

export function ApiPage({ project }: { project: Project }) {
  const [enrich, setEnrich] = useState(false);
  const [sourceType, setSourceType] = useState<"file" | "url">("file");
  const [openapiUrl, setOpenapiUrl] = useState("");
  const [result, setResult] = useState<SuiteResult>();
  const [agentResult, setAgentResult] = useState<{ message: string; tokens: number }>();
  const { busy, run } = useAction();
  const { goTab } = useProjects();

  const fromOpenapi = () => run(async () => {
    const file = await api().pickFile([{ name: "OpenAPI / Swagger", extensions: ["json", "yaml", "yml"] }]);
    if (!file) return;
    setResult((await api().generateApiSuite(project.id, file, enrich)) as SuiteResult);
    notifyProjectChanged(project.id);
  }, "接口用例与脚本已生成");

  const fromOpenapiUrl = () => run(async () => {
    const source = openapiUrl.trim();
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new Error("请输入有效的 OpenAPI HTTP/HTTPS 地址");
    }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("OpenAPI 地址仅支持 HTTP/HTTPS");
    setResult((await api().generateApiSuite(project.id, source, enrich)) as SuiteResult);
    notifyProjectChanged(project.id);
  }, "接口用例与脚本已生成");

  const fromRequirement = () => run(async () => {
    const file = await api().pickFile([{ name: "需求文档", extensions: ["md", "docx", "pdf", "txt"] }]);
    if (!file) return;
    setAgentResult((await api().generateCases(project.id, file)) as { message: string; tokens: number });
    notifyProjectChanged(project.id);
  }, "agent 已完成用例生成，请在用例库中审核");

  return (
    <>
      <PageHeader title="接口用例生成" description="从 OpenAPI 或需求文档生成用例，在「用例库」审核后，到「接口回归」选择测试范围并执行。" />
      <Steps size="small" style={{ marginBottom: 20 }} items={[
        { title: "解析 OpenAPI", description: "接口、参数约束、状态码" },
        { title: "生成用例", description: "正向 / 必填 / 边界 / 类型 / 鉴权 / 幂等" },
        { title: "人工审核", description: "在用例库中审核" },
        { title: "生成脚本", description: "pytest + httpx，数据驱动" },
        { title: "回归执行", description: "不调用模型" },
      ]} />
      <div className="split">
        <div style={{ flex: "1 1 320px", alignSelf: "stretch" }}>
          <Card title={<Space><ThunderboltOutlined />从 OpenAPI 生成</Space>} style={{ height: "100%" }}>
            <Typography.Paragraph type="secondary">
              确定性生成基线用例与脚本，不耗模型。需要业务场景（先创建再查询等接口依赖）时，可让 agent 在此基础上补充。
            </Typography.Paragraph>
            <Space direction="vertical" style={{ width: "100%" }}>
              <Segmented value={sourceType} disabled={busy} onChange={(value) => setSourceType(value as "file" | "url")}
                options={[{ label: "文件导入", value: "file" }, { label: "地址导入", value: "url" }]} />
              {sourceType === "url" && <>
                <Input aria-label="OpenAPI 文档地址" placeholder="https://example.com/v3/api-docs" value={openapiUrl}
                  onChange={(e) => setOpenapiUrl(e.target.value)} disabled={busy} />
                <Typography.Text type="secondary">填写 JSON/YAML 规范文档的 HTTP/HTTPS 地址，支持 OpenAPI 3.x 和 Swagger 2.0。</Typography.Text>
              </>}
              <Space><Switch checked={enrich} onChange={setEnrich} /><span>让 agent 补充业务场景用例（消耗模型）</span></Space>
              {sourceType === "file"
                ? <Button type="primary" loading={busy} onClick={fromOpenapi}>选择 OpenAPI 文件</Button>
                : <Button type="primary" loading={busy} disabled={!openapiUrl.trim()} onClick={fromOpenapiUrl}>从地址导入并生成</Button>}
            </Space>
          </Card>
        </div>
        <div style={{ flex: "1 1 320px", alignSelf: "stretch" }}>
          <Card title={<Space><RobotOutlined />从需求文档生成（agent）</Space>} style={{ height: "100%" }}>
            <Typography.Paragraph type="secondary">
              agent 读取 Word / PDF / Markdown 需求，按功能点设计用例并关联需求章节，自检规范后以草稿入库，等待人工审核。
            </Typography.Paragraph>
            <Button icon={<FileTextOutlined />} loading={busy} onClick={fromRequirement}>选择需求文档</Button>
          </Card>
        </div>
      </div>
      {result && (
        <Card style={{ marginTop: 16 }}>
          <Result
            status="success"
            title={`生成 ${result.generated?.generated ?? 0} 条接口用例，${result.suite?.cases ?? 0} 条进入脚本`}
            subTitle={result.suite?.skipped ? `${result.suite.skipped} 条因阻断级问题或已废弃未生成脚本` : "审核用例后即可执行回归"}
            extra={goTab && [
              <Button key="cases" onClick={() => goTab("cases")}>去用例库审核</Button>,
              <Button key="run" type="primary" onClick={() => goTab("run")}>去执行回归</Button>,
            ]}
          />
          <Descriptions size="small" column={1} bordered items={[
            { key: "f", label: "脚本", children: <span className="mono">{result.suite?.test}</span> },
            ...(result.suite?.version ? [{ key: "v", label: "git 提交", children: <span className="mono">{result.suite.version.slice(0, 10)}</span> }] : []),
            ...(result.agent ? [{ key: "a", label: "agent 用量", children: `${result.agent.tokens} tokens（${result.agent.status}）` }] : []),
          ]} />
        </Card>
      )}
      {agentResult && (
        <Alert style={{ marginTop: 16 }} type="info" showIcon message={`agent 已完成（${agentResult.tokens} tokens）`}
          description={<Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>{agentResult.message}</Typography.Paragraph>}
          action={goTab && <Button size="small" type="primary" onClick={() => goTab("cases")}>去用例库审核</Button>} />
      )}
    </>
  );
}
