import { Button, Dropdown, Empty, Popconfirm, Space, Tag, Tooltip, Typography } from "antd";
import { ArrowDown, ArrowUp, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
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
  testPanel: ReactNode;
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
  testPanel,
}: WorkflowWizardProps) {
  return (
    <div className="workflow-canvas">
      <aside className="workflow-canvas__palette">
        <div className="workflow-panel-heading">
          <Typography.Text className="section-eyebrow">动作库</Typography.Text>
          <Typography.Text type="secondary">{cards.length} 个动作</Typography.Text>
        </div>
        <div className="workflow-action-list">
          {cards.map((card) => (
            <button
              className="workflow-action-tile"
              key={card.type}
              type="button"
              onClick={() => onSelectCard(card)}
            >
              <span>
                <Tag bordered={false} color="gold">
                  {card.category}
                </Tag>
                <strong>{card.label}</strong>
              </span>
              <small>{card.description}</small>
            </button>
          ))}
        </div>
      </aside>

      <main className="workflow-canvas__flow">
        <div className="workflow-panel-heading">
          <div>
            <Typography.Text className="section-eyebrow">流程画布</Typography.Text>
            <Typography.Title level={5} style={{ margin: 0 }}>
              已编排 {steps.length} 个步骤
            </Typography.Title>
          </div>
          <Tag color={steps.length ? "green" : "default"}>{steps.length ? "可编辑" : "空流程"}</Tag>
        </div>
        <div className="workflow-step-scroll">
          {steps.length ? (
            steps.map((step, index) => {
              const locator = step.selector_key ? locators[step.selector_key] : null;
              const insertMenuItems = cards.map((card) => ({
                key: card.type,
                label: `${card.label} · ${card.category}`,
                onClick: () => onSelectCard(card, { insertAfterIndex: index }),
              }));
              return (
                <div key={step.id} className="workflow-step-item">
                  <div className="workflow-step-node">{index + 1}</div>
                  <div className="workflow-step-item__body">
                    <div className="workflow-step-item__title-row">
                      <Space wrap>
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
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 6 }}>
                      {stepSummary(step, locator)}
                    </Typography.Paragraph>
                    {locator ? (
                      <Typography.Text type="secondary">
                        主规则: {String(locator.primary_selector ?? "--")} / 稳定性 {String(locator.stability_score ?? "--")}
                      </Typography.Text>
                    ) : null}
                    <div className="workflow-step-item__insert-row">
                      <Dropdown trigger={["click"]} menu={{ items: insertMenuItems }} disabled={!cards.length}>
                        <Button
                          size="small"
                          type="dashed"
                          icon={<Plus size={14} />}
                          onClick={(event) => event.preventDefault()}
                        >
                          在这里插入动作
                        </Button>
                      </Dropdown>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <Empty
              className="workflow-empty-state"
              description="从左侧动作库选择第一个动作，画布会在这里生成步骤。"
            />
          )}
        </div>
      </main>

      <aside className="workflow-canvas__inspector">{testPanel}</aside>
    </div>
  );
}
