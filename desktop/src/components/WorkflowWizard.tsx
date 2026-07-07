import { Button, Dropdown, Empty, Popconfirm, Space, Tag, Tooltip, Typography } from "antd";
import {
  ArrowDown,
  ArrowUp,
  Camera,
  Clock3,
  Copy,
  Download,
  FileText,
  Globe2,
  ListTree,
  MousePointerClick,
  Pencil,
  Plus,
  ScrollText,
  Trash2,
  Type,
  UploadCloud,
} from "lucide-react";
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
  workflowName?: string;
  canvasMeta?: ReactNode;
  canvasActions?: ReactNode;
  readOnly?: boolean;
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
  if (step.type === "click") {
    if (step.click_target_mode === "random_many") {
      return `随机点击 ${step.random_click_count ?? 1} 个匹配目标`;
    }
    return "点击已选页面元素";
  }
  if (step.type === "fill") {
    return `输入内容: ${String(step.value ?? "${row.xxx}")}`;
  }
  if (step.type === "select") {
    return `选择下拉项: ${String(step.value ?? "${row.xxx}")}`;
  }
  if (step.type === "extract_text") {
    return `提取文本${step.save_as ? `到 ${step.save_as}` : ""}`;
  }
  if (step.type === "for_each") {
    return "循环列表或表格中的多行数据";
  }
  if (typeof step.value === "string" && step.value) {
    return `参数: ${step.value}`;
  }
  if (step.save_as) {
    return `输出变量: ${step.save_as}`;
  }
  return "等待补充元素定位和参数";
}

function actionVisual(type: string, options?: { hasUrl?: boolean }) {
  if (type === "click") {
    return { icon: <MousePointerClick size={16} />, label: "点击", tone: "action" };
  }
  if (type === "fill") {
    return { icon: <Type size={16} />, label: "输入", tone: "input" };
  }
  if (type === "select") {
    return { icon: <ListTree size={16} />, label: "选择", tone: "input" };
  }
  if (type === "wait" || type === "sleep") {
    return { icon: <Clock3 size={16} />, label: "等待", tone: "wait" };
  }
  if (type === "scroll") {
    return { icon: <ScrollText size={16} />, label: "滚动", tone: "navigate" };
  }
  if (type.includes("open") || options?.hasUrl) {
    return { icon: <Globe2 size={16} />, label: "打开", tone: "navigate" };
  }
  if (type.includes("download")) {
    return { icon: <Download size={16} />, label: "下载", tone: "file" };
  }
  if (type.includes("upload")) {
    return { icon: <UploadCloud size={16} />, label: "上传", tone: "file" };
  }
  if (type === "screenshot") {
    return { icon: <Camera size={16} />, label: "截图", tone: "file" };
  }
  if (type === "extract_text") {
    return { icon: <FileText size={16} />, label: "提取", tone: "data" };
  }
  if (type === "for_each") {
    return { icon: <ListTree size={16} />, label: "循环", tone: "data" };
  }
  return { icon: <FileText size={16} />, label: type, tone: "neutral" };
}

function stepVisual(step: WorkflowDraftStep) {
  return actionVisual(step.type, { hasUrl: Boolean(step.url) });
}

export function WorkflowWizard({
  cards,
  steps,
  locators,
  workflowName,
  canvasMeta,
  canvasActions,
  readOnly = false,
  onSelectCard,
  onEditStep,
  onDeleteStep,
  onDuplicateStep,
  onMoveStep,
  testPanel,
}: WorkflowWizardProps) {
  return (
    <div className={`workflow-canvas${readOnly ? " workflow-canvas--readonly" : ""}`}>
      <aside className="workflow-canvas__palette">
        <div className="workflow-panel-heading">
          <Typography.Text className="section-eyebrow">动作库</Typography.Text>
          <Typography.Text type="secondary">{readOnly ? "已锁定" : `${cards.length} 个动作`}</Typography.Text>
        </div>
        <div className="workflow-action-list">
          {cards.map((card) => {
            const visual = actionVisual(card.type);
            return (
              <button
                className="workflow-action-tile"
                disabled={readOnly}
                key={card.type}
                type="button"
                onClick={() => onSelectCard(card)}
              >
                <span className="workflow-action-tile__head">
                  <span className={`workflow-action-icon workflow-step-node--${visual.tone}`}>
                    {visual.icon}
                  </span>
                  <span className="workflow-action-tile__title">
                    <Tag bordered={false} className={`workflow-step-type workflow-step-type--${visual.tone}`}>
                      {visual.label}
                    </Tag>
                    <strong>{card.label}</strong>
                  </span>
                </span>
                <small>{card.description}</small>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="workflow-canvas__flow">
        <div className="workflow-panel-heading workflow-canvas-heading">
          <div className="workflow-canvas-heading__main">
            <Typography.Text className="section-eyebrow">流程画布 · {steps.length} 步</Typography.Text>
            <Typography.Title level={5} className="workflow-canvas-heading__title">
              {workflowName || "未选择流程"}
            </Typography.Title>
            {canvasMeta ? <div className="workflow-canvas-heading__meta">{canvasMeta}</div> : null}
          </div>
          <Space size={8} wrap className="workflow-canvas-heading__actions">
            {canvasActions}
            <Tag>{readOnly ? "已锁定" : steps.length ? "可编辑" : "空流程"}</Tag>
          </Space>
        </div>
        <div className="workflow-step-scroll">
          {steps.length ? (
            steps.map((step, index) => {
              const locator = step.selector_key ? locators[step.selector_key] : null;
              const visual = stepVisual(step);
              const insertMenuItems = cards.map((card) => ({
                key: card.type,
                label: `${card.label} · ${card.category}`,
                onClick: () => onSelectCard(card, { insertAfterIndex: index }),
              }));
              return (
                <div key={step.id} className="workflow-step-item">
                  <div className={`workflow-step-node workflow-step-node--${visual.tone}`}>
                    {visual.icon}
                  </div>
                  <div className="workflow-step-item__body">
                    <div className="workflow-step-item__title-row">
                      <Space wrap className="workflow-step-item__headline">
                        <Tag className={`workflow-step-type workflow-step-type--${visual.tone}`}>{visual.label}</Tag>
                        <Typography.Text type="secondary" className="workflow-step-index">
                          #{index + 1}
                        </Typography.Text>
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
                            disabled={readOnly}
                            onClick={() => onEditStep(index)}
                          />
                        </Tooltip>
                        <Tooltip title="复制步骤">
                          <Button
                            size="small"
                            type="text"
                            icon={<Copy size={15} />}
                            disabled={readOnly}
                            onClick={() => onDuplicateStep(index)}
                          />
                        </Tooltip>
                        <Tooltip title="上移">
                          <Button
                            size="small"
                            type="text"
                            icon={<ArrowUp size={15} />}
                            disabled={readOnly || index === 0}
                            onClick={() => onMoveStep(index, "up")}
                          />
                        </Tooltip>
                        <Tooltip title="下移">
                          <Button
                            size="small"
                            type="text"
                            icon={<ArrowDown size={15} />}
                            disabled={readOnly || index === steps.length - 1}
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
                          <Button size="small" type="text" danger disabled={readOnly} icon={<Trash2 size={15} />} />
                        </Popconfirm>
                      </Space>
                    </div>
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 6 }}>
                      {stepSummary(step, locator)}
                    </Typography.Paragraph>
                    <div className="workflow-step-item__insert-row">
                      <Dropdown trigger={["click"]} menu={{ items: insertMenuItems }} disabled={readOnly || !cards.length}>
                        <Button
                          size="small"
                          type="dashed"
                          icon={<Plus size={14} />}
                          disabled={readOnly}
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
              description={readOnly ? "当前流程已锁定，点击流程列表中的“编排”后再添加动作。" : "从左侧动作库选择第一个动作，画布会在这里生成步骤。"}
            />
          )}
        </div>
      </main>

      <aside className="workflow-canvas__inspector">{testPanel}</aside>
    </div>
  );
}
