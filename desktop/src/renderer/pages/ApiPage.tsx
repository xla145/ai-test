import { FileTextOutlined, RobotOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Descriptions, Result, Row, Space, Steps, Switch, Typography } from "antd";
import { useState } from "react";
import { api, type Project } from "../api";
import { PageHeader } from "../components/PageHeader";
import { useAction } from "../hooks";

interface SuiteResult {
  generated?: { generated: number };
  suite?: { cases: number; skipped: number; test: string; version?: string };
  agent?: { tokens: number; status: string };
}

export function ApiPage({ project }: { project: Project }) {
  const [enrich, setEnrich] = useState(false);
  const [result, setResult] = useState<SuiteResult>();
  const [agentResult, setAgentResult] = useState<{ message: string; tokens: number }>();
  const { busy, run } = useAction();

  const fromOpenapi = () => run(async () => {
    const file = await api().pickFile([{ name: "OpenAPI / Swagger", extensions: ["json", "yaml", "yml"] }]);
    if (file) setResult((await api().generateApiSuite(project.id, file, enrich)) as SuiteResult);
  }, "接口用例与脚本已生成");

  const fromRequirement = () => run(async () => {
    const file = await api().pickFile([{ name: "需求文档", extensions: ["md", "docx", "pdf", "txt"] }]);
    if (file) setAgentResult((await api().generateCases(project.id, file)) as { message: string; tokens: number });
  }, "agent 已完成用例生成，请在用例库中审核");

  return (
    <>
      <PageHeader title="接口测试" description="接口测试是主线：输入稳定、结果可判定。首次生成脚本后，回归直接执行，不再消耗模型。" />
      <Steps size="small" style={{ marginBottom: 20 }} items={[
        { title: "解析 OpenAPI", description: "接口、参数约束、状态码" },
        { title: "生成用例", description: "正向 / 必填 / 边界 / 类型 / 鉴权 / 幂等" },
        { title: "人工审核", description: "在用例库中审核" },
        { title: "生成脚本", description: "pytest + httpx，数据驱动" },
        { title: "回归执行", description: "不调用模型" },
      ]} />
      <Row gutter={16}>
        <Col span={12}>
          <Card title={<Space><ThunderboltOutlined />从 OpenAPI 生成</Space>} style={{ height: "100%" }}>
            <Typography.Paragraph type="secondary">
              确定性生成基线用例与脚本，不耗模型。需要业务场景（先创建再查询等接口依赖）时，可让 agent 在此基础上补充。
            </Typography.Paragraph>
            <Space direction="vertical" style={{ width: "100%" }}>
              <Space><Switch checked={enrich} onChange={setEnrich} /><span>让 agent 补充业务场景用例（消耗模型）</span></Space>
              <Button type="primary" loading={busy} onClick={fromOpenapi}>选择 OpenAPI 文件</Button>
            </Space>
          </Card>
        </Col>
        <Col span={12}>
          <Card title={<Space><RobotOutlined />从需求文档生成（agent）</Space>} style={{ height: "100%" }}>
            <Typography.Paragraph type="secondary">
              agent 读取 Word / PDF / Markdown 需求，按功能点设计用例并关联需求章节，自检规范后以草稿入库，等待人工审核。
            </Typography.Paragraph>
            <Button icon={<FileTextOutlined />} loading={busy} onClick={fromRequirement}>选择需求文档</Button>
          </Card>
        </Col>
      </Row>
      {result && (
        <Card style={{ marginTop: 16 }}>
          <Result
            status="success"
            title={`生成 ${result.generated?.generated ?? 0} 条接口用例，${result.suite?.cases ?? 0} 条进入脚本`}
            subTitle={result.suite?.skipped ? `${result.suite.skipped} 条因阻断级问题或已废弃未生成脚本` : "可在「接口回归」中执行"}
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
          description={<Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>{agentResult.message}</Typography.Paragraph>} />
      )}
    </>
  );
}
