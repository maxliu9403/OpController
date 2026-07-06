import { Button, Card, Col, Dropdown, Empty, Popconfirm, Row, Space, Tag, Tooltip, Typography } from "antd";
import { ArrowDown, ArrowUp, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import type { WorkflowActionCard } from "../types";

export type WorkflowDraftStep = {
  id: string;
  type: string;
  label?: string | null;
  selector_key?: string | null;
  url?: string | null;
  value?: unknown;
  save_as?: string | null;
  timeout_sec?: number | null;
  click_target_mode?: string | null;
  random_click_count?: number | null;
  scroll_direction?: string | null;
  scroll_distance?: number | null;
  scroll_repeat?: number | null;
  scroll_pause_ms?: number | null;
  wait_mode?: string | null;
  on_timeout?: string | null;
  min_count?: number | null;
  stable_ms?: number | null;
  optional?: boolean | null;
  steps?: WorkflowDraftStep[];
};

type WorkflowWizardProps = {
  cards: WorkflowActionCard[];
  steps: WorkflowDraftStep[];
  locators: Record<string, Record<string, unknown>>;
  onSelectCard: (card: WorkflowActionCard, options?: { insertAfterIndex?: number }) => void;
  onEditStep: (index: number) => void;
  onDeleteStep: (index: number) => void;
  onDuplicateStep: (index: number) => void;
  onMoveStep: (index: number, direction: "up" | "down") => void;
};

function looksLikeLegacyPageWait(step: WorkflowDraftStep, locator?: Record<string, unknown> | null) {
  const selector = String(locator?.primary_selector ?? "");
  const textSignature = (locator?.text_signature ?? {}) as Record<string, unknown>;
  const fallback = Array.isArray(locator?.fallback_selectors) ? locator.fallback_selectors.map(String) : [];
  const label = `${step.label ?? ""} ${selector} ${String(textSignature.normalized ?? "")}`;
  return step.type === "wait" &&
    step.wait_mode === "element_visible" &&
    label.includes("页面") &&
    (fallback.includes("div") || selector === "div" || selector.includes("等待页面"));
}

function stepSummary(step: WorkflowDraftStep, locator?: Record<string, unknown> | null) {
  if (step.type === "wait") {
    const timeoutText = step.on_timeout === "continue_with_warning" || step.optional ? "超时继续" : "超时失败";
    if (looksLikeLegacyPageWait(step, locator)) {
      return `旧版页面等待，运行时会自动升级为智能等待页面加载完成 / ${timeoutText}`;
    }
    if (step.wait_mode === "page_ready") {
      return `智能等待页面加载完成 / 稳定 ${step.stable_ms ?? 2500}ms / ${timeoutText}`;
    }
    if (step.wait_mode === "element_count") {
      return `等待元素数量 >= ${step.min_count ?? 1} / ${timeoutText}`;
    }
    if (step.wait_mode === "page_stable") {
      return `等待页面稳定 ${step.stable_ms ?? 1200}ms / ${timeoutText}`;
    }
    if (step.wait_mode === "element_hidden") {
      return `等待加载元素消失 / ${timeoutText}`;
    }
    return `等待元素出现 / ${timeoutText}`;
  }
  if (step.url) {
    return `页面: ${step.url}`;
  }
  if (step.type === "sleep") {
    return `停留 ${String(step.value ?? 1)} 秒后继续`;
  }
  if (step.type === "scroll") {
    const direction = step.scroll_direction === "up" ? "向上" : "向下";
    return `${direction}慢速拟人化滚动 ${step.scroll_distance ?? step.value ?? 320}px，重复 ${step.scroll_repeat ?? 4} 次，间隔 ${step.scroll_pause_ms ?? 1200}ms`;
  }
  if (step.selector_key) {
    if (step.type === "click" && step.click_target_mode === "random_many") {
      return `定位键: ${step.selector_key} / 随机点击 ${step.random_click_count ?? 1} 个匹配元素`;
    }
    return `定位键: ${step.selector_key}`;
  }
  if (typeof step.value === "string" && step.value) {
    return `参数: ${step.value}`;
  }
  if (step.save_as) {
    return `输出变量: ${step.save_as}`;
  }
  return "等待补充元素定位和参数";
}

export function WorkflowWizard({
  cards,
  steps,
  locators,
  onSelectCard,
  onEditStep,
  onDeleteStep,
  onDuplicateStep,
  onMoveStep,
}: WorkflowWizardProps) {
  return (
    <Space direction="vertical" size={20} style={{ width: "100%" }}>
      <Card className="wizard-hero">
        <Typography.Title level={3}>面向运营的流程编排</Typography.Title>
        <Typography.Paragraph>
          先点动作卡片，再用业务化表单告诉系统“这个元素长什么样”。不需要懂 CSS、XPath，也不需要手写 YAML。
        </Typography.Paragraph>
      </Card>

      <Card className="wizard-rail">
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text className="section-eyebrow">动作卡片</Typography.Text>
          <Row gutter={[12, 12]}>
            {cards.map((card) => (
              <Col xs={24} md={12} xl={8} key={card.type}>
                <Card className="action-card" hoverable onClick={() => onSelectCard(card)}>
                  <Space direction="vertical" size={10}>
                    <Tag bordered={false} color="gold">
                      {card.category}
                    </Tag>
                    <Typography.Title level={5}>{card.label}</Typography.Title>
                    <Typography.Paragraph type="secondary">{card.description}</Typography.Paragraph>
                    <Button type="link" className="action-card__button">
                      配置这个动作
                    </Button>
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        </Space>
      </Card>

      <Card className="wizard-rail">
        <Space direction="vertical" size={14} style={{ width: "100%" }}>
          <Typography.Text className="section-eyebrow">怎么告诉程序点哪里</Typography.Text>
          <Typography.Paragraph type="secondary">
            首版不是让运营同学提供坐标，而是让运营同学描述元素特征。系统会把这些特征自动转换成 LocatorSpec。
          </Typography.Paragraph>
          <div className="wizard-guide-grid">
            <div className="wizard-guide-card">
              <Typography.Title level={5}>1. 先说这是什么</Typography.Title>
              <Typography.Paragraph type="secondary">
                例如：提交按钮、搜索输入框、店铺状态下拉框。
              </Typography.Paragraph>
            </div>
            <div className="wizard-guide-card">
              <Typography.Title level={5}>2. 再说怎么稳定找到它</Typography.Title>
              <Typography.Paragraph type="secondary">
                优先填稳定属性，其次填元素文字，再补邻近文案和列表行业务关键词。
              </Typography.Paragraph>
            </div>
            <div className="wizard-guide-card">
              <Typography.Title level={5}>3. 让系统自动生成规则</Typography.Title>
              <Typography.Paragraph type="secondary">
                系统会自动写入 `selector_key` 和 `locators`，高级 YAML 只是可选查看层。
              </Typography.Paragraph>
            </div>
          </div>
        </Space>
      </Card>

      <Card className="wizard-rail">
        <Space direction="vertical" size={14} style={{ width: "100%" }}>
          <Typography.Text className="section-eyebrow">已编排步骤</Typography.Text>
          {steps.length ? (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              {steps.map((step, index) => {
                const locator = step.selector_key ? locators[step.selector_key] : null;
                const insertMenuItems = cards.map((card) => ({
                  key: card.type,
                  label: `${card.label} · ${card.category}`,
                  onClick: () => onSelectCard(card, { insertAfterIndex: index }),
                }));
                return (
                  <div key={step.id} className="workflow-step-item">
                    <div className="workflow-step-item__header">
                      <div className="workflow-step-item__title-row">
                        <Space wrap>
                          <Tag color="blue">#{index + 1}</Tag>
                          <Tag color="gold">{step.type}</Tag>
                          <Typography.Title level={5} style={{ margin: 0 }}>
                            {step.label || step.id}
                          </Typography.Title>
                        </Space>
                        <Space size={4} wrap>
                          <Tooltip title="编辑步骤">
                            <Button
                              size="small"
                              type="text"
                              icon={<Pencil size={15} />}
                              onClick={() => onEditStep(index)}
                            />
                          </Tooltip>
                          <Tooltip title="复制步骤">
                            <Button
                              size="small"
                              type="text"
                              icon={<Copy size={15} />}
                              onClick={() => onDuplicateStep(index)}
                            />
                          </Tooltip>
                          <Tooltip title="上移">
                            <Button
                              size="small"
                              type="text"
                              icon={<ArrowUp size={15} />}
                              disabled={index === 0}
                              onClick={() => onMoveStep(index, "up")}
                            />
                          </Tooltip>
                          <Tooltip title="下移">
                            <Button
                              size="small"
                              type="text"
                              icon={<ArrowDown size={15} />}
                              disabled={index === steps.length - 1}
                              onClick={() => onMoveStep(index, "down")}
                            />
                          </Tooltip>
                          <Popconfirm
                            title="删除这个步骤？"
                            description="删除后会同步更新 YAML，并清理不再使用的定位规则。"
                            okText="删除"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => onDeleteStep(index)}
                          >
                            <Button size="small" type="text" danger icon={<Trash2 size={15} />} />
                          </Popconfirm>
                        </Space>
                      </div>
                    </div>
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 6 }}>
                      {stepSummary(step, locator)}
                    </Typography.Paragraph>
                    {locator ? (
                      <Typography.Text type="secondary">
                        主规则: {String(locator.primary_selector ?? "--")} / 稳定性 {String(locator.stability_score ?? "--")}
                      </Typography.Text>
                        ) : null}
                    <div className="workflow-step-item__insert-row">
                      <Dropdown
                        trigger={["click"]}
                        menu={{ items: insertMenuItems }}
                        disabled={!cards.length}
                      >
                        <Button
                          size="small"
                          type="dashed"
                          icon={<Plus size={14} />}
                          onClick={(event) => event.preventDefault()}
                        >
                          在第 {index + 1} 步后插入动作
                        </Button>
                      </Dropdown>
                    </div>
                  </div>
                );
              })}
            </Space>
          ) : (
            <Empty description="还没有步骤。点击上面的动作卡片，先配置一个可执行动作。" />
          )}
        </Space>
      </Card>
    </Space>
  );
}
