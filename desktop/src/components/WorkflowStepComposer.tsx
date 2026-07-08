import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import type {
  LocatorLivePreview,
  LocatorPickResult,
  PickedElementSummary,
  StepLivePreviewResult,
  WorkflowActionCard,
} from "../types";

export type StepComposerValues = {
  stepLabel: string;
  url?: string;
  value?: string | number;
  saveAs?: string;
  timeoutSec?: number;
  clickTargetMode?: "unique" | "random_many";
  randomClickCount?: number;
  scrollDirection?: "down" | "up";
  scrollDistance?: number;
  scrollRepeat?: number;
  scrollPauseMs?: number;
  waitMode?: "page_ready" | "element_visible" | "element_hidden" | "element_count" | "page_stable";
  onTimeout?: "fail" | "continue_with_warning";
  minCount?: number;
  stableMs?: number;
  optional?: boolean;
  targetName?: string;
  tagName?: string;
  visibleText?: string;
  attributeKey?: string;
  attributeValue?: string;
  neighborText?: string;
  listRowAnchor?: string;
};

export type LocatorPreview = {
  valid: boolean;
  warnings: string[];
  uniqueness_score: number;
  stability_score: number;
  locator: Record<string, unknown>;
  live_preview?: LocatorLivePreview;
  picked_element?: PickedElementSummary;
};

type WorkflowStepComposerProps = {
  open: boolean;
  card: WorkflowActionCard | null;
  mode?: "create" | "edit" | "insert";
  insertAfterLabel?: string | null;
  initialValues?: StepComposerValues | null;
  initialLocatorPreview?: LocatorPreview | null;
  testSessionLabel?: string | null;
  previewAvailable: boolean;
  onCancel: () => void;
  onSubmit: (values: StepComposerValues, locatorPreview: LocatorPreview | null) => Promise<void>;
  validateLocator: (values: StepComposerValues) => Promise<LocatorPreview>;
  pickLocator: (values: StepComposerValues) => Promise<LocatorPickResult>;
  onPreviewStep: (values: StepComposerValues, locatorPreview: LocatorPreview | null) => Promise<StepLivePreviewResult>;
};

const TAG_OPTIONS = [
  { value: "button", label: "按钮 button" },
  { value: "input", label: "输入框 input" },
  { value: "select", label: "下拉框 select" },
  { value: "a", label: "链接 a" },
  { value: "div", label: "容器 div" },
  { value: "span", label: "文本 span" },
];

function requiresLocator(type: string, waitMode?: string) {
  if (type === "wait") {
    return waitMode !== "page_stable" && waitMode !== "page_ready";
  }
  return ["click", "fill", "select", "wait_visible", "extract_text", "for_each"].includes(type);
}

function supportsBusinessForm(type: string) {
  return ["goto", "click", "fill", "select", "wait_visible", "wait", "sleep", "scroll", "screenshot", "extract_text", "for_each"].includes(type);
}

function isLocatorFieldChanged(changedValues: Partial<StepComposerValues>) {
  return [
    "targetName",
    "tagName",
    "visibleText",
    "attributeKey",
    "attributeValue",
    "neighborText",
    "listRowAnchor",
  ].some((key) => key in changedValues);
}

function bestStableAttribute(attributes: Record<string, string>) {
  const preferred = [
    "data-testid",
    "data-test",
    "data-cy",
    "data-qa",
    "data-automation-id",
    "id",
    "name",
    "aria-label",
    "placeholder",
    "title",
  ];
  const key = preferred.find((item) => attributes[item]);
  if (key) {
    return [key, attributes[key]] as const;
  }
  const dataKey = Object.keys(attributes).find((item) => item.startsWith("data-") && attributes[item]);
  return dataKey ? ([dataKey, attributes[dataKey]] as const) : null;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pickedValuesForForm(
  result: LocatorPickResult,
  card: WorkflowActionCard,
  previous: StepComposerValues,
): Partial<StepComposerValues> {
  const element = result.element;
  if (!element) {
    return {};
  }
  const stable = bestStableAttribute(element.attributes ?? {});
  const neighbor =
    stringField(element.neighbor_anchor?.previous_text) ||
    stringField(element.neighbor_anchor?.next_text) ||
    stringField(element.neighbor_anchor?.parent_text);
  const rowText = stringField(element.list_context?.row_text);
  const visibleText = element.text?.trim();
  return {
    targetName: previous.targetName?.trim() || visibleText || previous.stepLabel || card.label,
    tagName: element.tag_name || previous.tagName,
    visibleText: visibleText || previous.visibleText,
    attributeKey: stable?.[0] ?? previous.attributeKey,
    attributeValue: stable?.[1] ?? previous.attributeValue,
    neighborText: neighbor ?? previous.neighborText,
    listRowAnchor: card.type === "for_each" ? rowText ?? previous.listRowAnchor : previous.listRowAnchor,
  };
}

function defaultValuesForCard(card: WorkflowActionCard | null): StepComposerValues {
  if (!card) {
    return { stepLabel: "" };
  }
  const base: StepComposerValues = {
    stepLabel: card.label,
    tagName:
      card.type === "fill"
        ? "input"
        : card.type === "select"
          ? "select"
          : card.type === "for_each"
            ? "div"
            : "button",
    timeoutSec: card.type === "wait_visible" || card.type === "wait" ? 20 : 15,
  };
  if (card.type === "click") {
    return { ...base, clickTargetMode: "unique", randomClickCount: 1 };
  }
  if (card.type === "goto") {
    return { ...base, url: "https://example.com" };
  }
  if (card.type === "fill") {
    return { ...base, value: "${row.keyword}" };
  }
  if (card.type === "select") {
    return { ...base, value: "${row.status}" };
  }
  if (card.type === "extract_text") {
    return { ...base, saveAs: "page_value" };
  }
  if (card.type === "screenshot") {
    return { ...base, saveAs: "last_screenshot_path" };
  }
  if (card.type === "wait") {
    return {
      ...base,
      stepLabel: "等待页面就绪",
      tagName: "div",
      waitMode: "page_ready",
      onTimeout: "fail",
      minCount: 1,
      stableMs: 2500,
      optional: false,
    };
  }
  if (card.type === "sleep") {
    return { ...base, stepLabel: "停留等待", value: "5", timeoutSec: 15 };
  }
	  if (card.type === "scroll") {
	    return {
	      ...base,
	      stepLabel: "滚动页面",
	      scrollDirection: "down",
	      scrollDistance: 320,
	      scrollRepeat: 4,
	      scrollPauseMs: 1200,
	      timeoutSec: 15,
	    };
	  }
  return base;
}

export function WorkflowStepComposer({
  open,
  card,
  mode = "create",
  insertAfterLabel,
  initialValues,
  initialLocatorPreview,
  testSessionLabel,
  previewAvailable,
  onCancel,
  onSubmit,
  validateLocator,
  pickLocator,
  onPreviewStep,
}: WorkflowStepComposerProps) {
  const [form] = Form.useForm<StepComposerValues>();
  const [locatorPreview, setLocatorPreview] = useState<LocatorPreview | null>(null);
  const [stepPreview, setStepPreview] = useState<StepLivePreviewResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [previewingStep, setPreviewingStep] = useState(false);
  const watchedWaitMode = Form.useWatch("waitMode", form);

  useEffect(() => {
    if (!open) {
      return;
    }
    form.resetFields();
    form.setFieldsValue({ ...defaultValuesForCard(card), ...(initialValues ?? {}) });
    setLocatorPreview(initialLocatorPreview ?? null);
    setStepPreview(null);
  }, [card, form, initialLocatorPreview, initialValues, open]);

  const needsLocator = useMemo(() => (card ? requiresLocator(card.type, watchedWaitMode) : false), [card, watchedWaitMode]);
  const businessModeReady = useMemo(() => (card ? supportsBusinessForm(card.type) : false), [card]);

  const handleValidateLocator = async () => {
    try {
      const values = await form.validateFields(needsLocator ? ["stepLabel", "targetName", "tagName"] : []);
      setValidating(true);
      const result = await validateLocator(values);
      setLocatorPreview(result);
      setStepPreview(null);
      if (result.valid) {
        message.success(`定位规则已生成，稳定性 ${result.stability_score}`);
      } else {
        message.warning("定位规则已生成，但稳定性偏低，建议补充稳定属性或邻近锚点。");
      }
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "定位规则生成失败");
    } finally {
      setValidating(false);
    }
  };

  const handlePickLocator = async () => {
    if (!card) {
      return;
    }
    if (!previewAvailable) {
      message.warning("请先打开测试指纹窗口，再从真实页面点选元素。");
      return;
    }
    try {
      const values = await form.validateFields(["stepLabel"]);
      setPicking(true);
      setStepPreview(null);
      message.info("拾取模式已开启：请到指纹浏览器页面里移动鼠标并点击目标元素，按 Esc 可取消。");
      const result = await pickLocator({ ...form.getFieldsValue(), ...values });
      if (!result.success || !result.locator || !result.element) {
        throw new Error(result.error_message ?? "没有获取到有效元素");
      }
      const currentValues = form.getFieldsValue();
      form.setFieldsValue(pickedValuesForForm(result, card, currentValues));
      setLocatorPreview({
        valid: result.warnings.length === 0,
        warnings: result.warnings,
        uniqueness_score: result.uniqueness_score,
        stability_score: result.stability_score,
        locator: result.locator,
        live_preview: result.live_preview ?? undefined,
        picked_element: result.element,
      });
      message.success("元素已自动提取并生成定位规则，请确认预览后保存动作。");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "页面元素拾取失败");
    } finally {
      setPicking(false);
    }
  };

  const handlePreviewStep = async () => {
    try {
      const values = await form.validateFields();
      let preview = locatorPreview;
      if (needsLocator && !preview) {
        setValidating(true);
        preview = await validateLocator(values);
        setLocatorPreview(preview);
      }
      setPreviewingStep(true);
      const result = await onPreviewStep(values, preview);
      setStepPreview(result);
      if (result.success) {
        message.success("单步试跑成功");
      } else {
        message.error(result.error_message ?? "单步试跑失败");
      }
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "单步试跑失败");
    } finally {
      setValidating(false);
      setPreviewingStep(false);
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      let preview = locatorPreview;
      if (needsLocator && !preview) {
        setValidating(true);
        preview = await validateLocator(values);
        setLocatorPreview(preview);
      }
      setSubmitting(true);
      await onSubmit(values, preview);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "步骤保存失败");
    } finally {
      setValidating(false);
      setSubmitting(false);
    }
  };

	  return (
	    <Drawer
	      title={card ? `${mode === "edit" ? "编辑步骤" : mode === "insert" ? "插入步骤" : "配置步骤"}: ${card.label}` : "配置步骤"}
      placement="right"
      width={560}
      open={open}
      onClose={onCancel}
      extra={
        <Space>
          <Button onClick={onCancel}>取消</Button>
	          <Button type="primary" loading={submitting} onClick={handleSubmit}>
	            {mode === "edit" ? "更新步骤" : mode === "insert" ? "插入到流程" : "写入流程"}
	          </Button>
        </Space>
      }
    >
      {!card ? null : (
        <Space direction="vertical" size={18} style={{ width: "100%" }}>
	          <Alert
	            type="info"
	            showIcon
	            message={
	              mode === "edit"
	                ? "正在编辑已有步骤"
	                : mode === "insert"
	                  ? `正在插入新步骤${insertAfterLabel ? `：${insertAfterLabel} 后面` : ""}`
	                  : "主路径：打开测试页面，然后直接点选元素"
	            }
	            description={
	              mode === "edit"
	                ? "表单已经回填原来的参数和定位规则。修改后会覆盖当前步骤，并同步更新 YAML。"
	                : mode === "insert"
	                  ? "保存后会把这个动作插入到指定位置，后面的步骤会自动顺延。你可以用它把“等待页面就绪”放到打开页面后面。"
	                : "运营同事不需要写选择器，也不需要猜稳定属性。点击“从页面点选元素”后，到指纹浏览器里点一下目标按钮/输入框，系统会自动提取文字、属性、邻近锚点并写进 YAML。"
	            }
	          />

          <Alert
            type={previewAvailable ? "success" : "warning"}
            showIcon
            message={previewAvailable ? `当前测试会话: ${testSessionLabel}` : "还没有打开测试指纹窗口"}
            description={
              previewAvailable
                ? "你现在可以从真实页面点选元素、自动生成定位规则，并做单步试跑。"
                : "请先在流程页顶部选择一个测试指纹窗口并打开它，否则这里只能生成规则，不能在真实页面验证。"
            }
          />

          {!businessModeReady ? (
            <Alert
              type="warning"
              showIcon
              message="这个动作还需要高级 YAML 配合"
              description="当前首版优先把点击、输入、下拉、等待、提取文本这类高频动作做成运营友好的向导。复杂分支和下载会继续补齐。"
            />
          ) : null}

          <Form
            form={form}
            layout="vertical"
            onValuesChange={(changedValues) => {
              if (isLocatorFieldChanged(changedValues)) {
                setLocatorPreview(null);
              }
              setStepPreview(null);
            }}
          >
            <Form.Item
              name="stepLabel"
              label="步骤名称"
              rules={[{ required: true, message: "给这个动作起一个容易看懂的名字" }]}
            >
              <Input placeholder="例如：点击提交按钮" />
            </Form.Item>

            {card.type === "goto" ? (
              <Form.Item
                name="url"
                label="页面地址"
                rules={[{ required: true, message: "请输入要打开的页面地址" }]}
              >
                <Input placeholder="https://seller.example.com/orders" />
              </Form.Item>
            ) : null}

            {needsLocator ? (
              <>
                <div className="locator-pick-panel">
                  <div>
                    <Typography.Title level={5} style={{ margin: 0 }}>
                      目标元素
                    </Typography.Title>
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                      推荐直接从页面点选。下面字段会自动回填，只在自动识别不够稳定时再手动补充。
                    </Typography.Paragraph>
                  </div>
                  <Button
                    type="primary"
                    size="large"
                    disabled={!previewAvailable}
                    loading={picking}
                    onClick={() => void handlePickLocator()}
                  >
                    从页面点选元素
                  </Button>
                </div>

                <Form.Item
                  name="targetName"
                  label="业务对象名称"
                  rules={[{ required: true, message: "请输入业务对象名称" }]}
                >
                  <Input placeholder="例如：提交按钮 / 搜索输入框 / 店铺状态下拉框" />
                </Form.Item>

                <Form.Item
                  name="tagName"
                  label="元素类型"
                  rules={[{ required: true, message: "请选择元素类型" }]}
                >
                  <Select options={TAG_OPTIONS} />
                </Form.Item>

                <Form.Item name="visibleText" label="元素可见文字">
                  <Input placeholder="例如：提交 / 搜索 / 保存。没有文字时可以留空。" />
                </Form.Item>

                <Form.Item name="attributeKey" label="稳定属性名">
                  <Input placeholder="例如：data-testid / id / name / placeholder / aria-label" />
                </Form.Item>

                <Form.Item name="attributeValue" label="稳定属性值">
                  <Input placeholder="例如：submit-btn / keyword / save-button" />
                </Form.Item>

                <Form.Item name="neighborText" label="邻近锚点文字">
                  <Input placeholder="例如：按钮左边写着“操作” / 输入框上方写着“关键词”" />
                </Form.Item>

                {card.type === "for_each" ? (
                  <Form.Item name="listRowAnchor" label="列表行业务关键词">
                    <Input placeholder="例如：先找到包含 ${row.order_no} 的那一行，再在行内执行动作" />
                  </Form.Item>
                ) : null}

                <Space wrap>
                  <Tag color="green">推荐页面点选</Tag>
                  <Tag color="gold">自动提取稳定属性</Tag>
                  <Tag color="blue">自动读取可见文字</Tag>
                  <Tag color="cyan">列表页自动带行上下文</Tag>
                </Space>
              </>
            ) : null}

            {card.type === "click" ? (
              <>
                <Form.Item
                  name="clickTargetMode"
                  label="多个相同元素时怎么点击"
                  tooltip="默认要求定位到唯一元素；如果页面上有很多一样的入口，可以选择随机点击多个。"
                >
                  <Select
                    options={[
                      { value: "unique", label: "只允许唯一命中，避免误点" },
                      { value: "random_many", label: "允许多命中，随机点击多个" },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  noStyle
                  shouldUpdate={(previous, current) => previous.clickTargetMode !== current.clickTargetMode}
                >
                  {({ getFieldValue }) =>
                    getFieldValue("clickTargetMode") === "random_many" ? (
	                      <Form.Item
	                        name="randomClickCount"
	                        label="随机点击次数"
	                        extra="安全上限为 5 次；如果命中过多元素，运行时会停止并提示缩小定位范围。"
	                        rules={[{ required: true, message: "请输入随机点击次数" }]}
	                      >
                        <InputNumber min={1} max={5} style={{ width: "100%" }} />
                      </Form.Item>
                    ) : (
                      <Alert
                        type="info"
                        showIcon
                        message="当前为安全点击模式"
                        description="如果定位规则命中多个元素，系统会停止并提示你重新拾取或切换为随机点击多个。"
                      />
                    )
                  }
                </Form.Item>
              </>
            ) : null}

            {card.type === "wait" ? (
              <>
                <Form.Item
                  name="waitMode"
                  label="等待方式"
                  tooltip="选择这一步用什么条件判断页面真的可操作。"
                >
                  <Select
	                    options={[
	                      { value: "page_ready", label: "智能等待页面加载完成（推荐）" },
	                      { value: "element_visible", label: "等待元素出现，例如搜索框/按钮" },
	                      { value: "element_hidden", label: "等待加载中元素消失，例如骨架屏/遮罩" },
	                      { value: "element_count", label: "等待列表数量达到阈值" },
                      { value: "page_stable", label: "等待页面 DOM 稳定" },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  name="onTimeout"
                  label="超时后怎么处理"
                  tooltip="核心路径建议失败；增强动作或可选内容建议继续并记录警告。"
                >
                  <Select
                    options={[
                      { value: "fail", label: "失败并停止任务" },
                      { value: "continue_with_warning", label: "继续执行，但在结果中记录警告" },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  noStyle
                  shouldUpdate={(previous, current) => previous.waitMode !== current.waitMode}
                >
                  {({ getFieldValue }) =>
	                    getFieldValue("waitMode") === "element_count" ? (
	                      <Form.Item name="minCount" label="最少元素数量">
	                        <InputNumber min={0} max={10000} style={{ width: "100%" }} />
	                      </Form.Item>
	                    ) : getFieldValue("waitMode") === "page_stable" || getFieldValue("waitMode") === "page_ready" ? (
	                      <Form.Item name="stableMs" label="页面稳定持续时间（毫秒）">
	                        <InputNumber min={300} max={10000} style={{ width: "100%" }} />
	                      </Form.Item>
                    ) : null
                  }
                </Form.Item>
                <Alert
                  type="info"
	                  showIcon
	                  message="建议用法"
	                  description="打开页面后优先选择“智能等待页面加载完成”；如果要等 Feed 商品或搜索结果，选择“等待列表数量达到阈值”并从页面点选一条稳定的列表元素。"
	                />
              </>
            ) : null}

	            {card.type === "fill" ? (
              <Form.Item
                name="value"
                label="输入内容"
                rules={[{ required: true, message: "请输入要填写的内容或变量" }]}
              >
                <Input placeholder="例如：${row.keyword}" />
              </Form.Item>
	            ) : null}

	            {card.type === "sleep" ? (
	              <Form.Item
	                name="value"
	                label="停留秒数"
	                rules={[{ required: true, message: "请输入停留秒数" }]}
	                tooltip="调试流程时可以在最后插入 10-30 秒，方便观察页面是否已经完成动作。"
	              >
	                <InputNumber min={1} max={600} style={{ width: "100%" }} />
	              </Form.Item>
	            ) : null}

	            {card.type === "scroll" ? (
	              <>
	                <Form.Item
	                  name="scrollDirection"
	                  label="滚动方向"
	                  tooltip="页面向下滚动用于加载更多内容；向上滚动用于回到页面上方继续操作。"
	                >
	                  <Select
	                    options={[
	                      { value: "down", label: "向下滚动" },
	                      { value: "up", label: "向上滚动" },
	                    ]}
	                  />
	                </Form.Item>
		                <Form.Item
		                  name="scrollDistance"
		                  label="每段滚动距离（像素）"
		                  rules={[{ required: true, message: "请输入滚动距离" }]}
		                >
		                  <InputNumber min={1} max={50000} style={{ width: "100%" }} />
	                </Form.Item>
	                <Form.Item
	                  name="scrollRepeat"
	                  label="重复次数"
	                  rules={[{ required: true, message: "请输入重复次数" }]}
	                >
	                  <InputNumber min={1} max={100} style={{ width: "100%" }} />
	                </Form.Item>
	                <Form.Item name="scrollPauseMs" label="每次间隔（毫秒）">
	                  <InputNumber min={0} max={10000} style={{ width: "100%" }} />
	                </Form.Item>
	                <Alert
		                  type="info"
		                  showIcon
		                  message="拟人化滚动已默认开启"
		                  description="系统会把每段滚动再拆成多个小滚轮事件，随机停顿阅读，并偶尔轻微反向滚动。列表页加载更多时，建议每段 260-420 像素，重复 4-8 次，每段间隔 1000-2000ms。"
		                />
	              </>
	            ) : null}

            {card.type === "select" ? (
              <Form.Item
                name="value"
                label="下拉项值"
                rules={[{ required: true, message: "请输入要选择的值或变量" }]}
              >
                <Input placeholder="例如：enabled / ${row.status}" />
              </Form.Item>
            ) : null}

            {card.type === "extract_text" || card.type === "screenshot" ? (
              <Form.Item name="saveAs" label="保存到变量">
                <Input placeholder="例如：page_value / last_screenshot_path" />
              </Form.Item>
            ) : null}

            <Form.Item name="timeoutSec" label="超时时间（秒）">
              <InputNumber min={3} max={120} style={{ width: "100%" }} />
            </Form.Item>
          </Form>

          {needsLocator ? (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Space wrap>
                <Button type="primary" disabled={!previewAvailable} loading={picking} onClick={() => void handlePickLocator()}>
                  从页面点选并自动生成
                </Button>
                <Button type="dashed" loading={validating} onClick={handleValidateLocator}>
                  手动生成并校验定位规则
                </Button>
              </Space>

              {locatorPreview ? (
                <>
                  {locatorPreview.picked_element ? (
                    <div className="locator-pick-result">
                      {locatorPreview.picked_element.screenshot_data_url ? (
                        <img
                          src={locatorPreview.picked_element.screenshot_data_url}
                          alt="picked element"
                          className="locator-pick-result__image"
                        />
                      ) : null}
                      <div className="locator-pick-result__body">
                        <Typography.Text strong>
                          已点选 {locatorPreview.picked_element.tag_name}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          {locatorPreview.picked_element.text || "无可见文字"}
                        </Typography.Text>
                        <Space wrap>
                          <Tag color="green">稳定性 {locatorPreview.stability_score}</Tag>
                          {locatorPreview.live_preview ? (
                            <Tag color={locatorPreview.live_preview.match_count === 1 ? "green" : "gold"}>
                              复测命中 {locatorPreview.live_preview.match_count}
                            </Tag>
                          ) : null}
                        </Space>
                      </div>
                    </div>
                  ) : null}

                  <Descriptions
                    size="small"
                    bordered
                    column={1}
                    title="定位结果预览"
                    items={[
                      {
                        key: "primary",
                        label: "主定位规则",
                        children: String(locatorPreview.locator.primary_selector ?? "--"),
                      },
                      {
                        key: "fallback",
                        label: "候补规则",
                        children: Array.isArray(locatorPreview.locator.fallback_selectors)
                          ? (locatorPreview.locator.fallback_selectors as string[]).join(" / ")
                          : "--",
                      },
                      {
                        key: "score",
                        label: "评分",
                        children: `稳定性 ${locatorPreview.stability_score} / 唯一性 ${locatorPreview.uniqueness_score}`,
                      },
                      {
                        key: "live",
                        label: "真实页面命中",
                        children: locatorPreview.live_preview
                          ? `${locatorPreview.live_preview.match_count} 个元素`
                          : "尚未在真实页面验证",
                      },
                    ]}
                  />
                  {locatorPreview.live_preview ? (
                    <Descriptions
                      size="small"
                      bordered
                      column={1}
                      title="真实页面验证"
                      items={[
                        {
                          key: "used",
                          label: "命中规则",
                          children: locatorPreview.live_preview.selector_used ?? "--",
                        },
                        {
                          key: "texts",
                          label: "样本文本",
                          children: locatorPreview.live_preview.matched_texts.length
                            ? locatorPreview.live_preview.matched_texts.join(" / ")
                            : "--",
                        },
                        {
                          key: "url",
                          label: "当前页面",
                          children: locatorPreview.live_preview.current_url ?? "--",
                        },
                      ]}
                    />
                  ) : null}
                  {locatorPreview.warnings.length ? (
                    <Alert
                      type="warning"
                      showIcon
                      message="定位规则提醒"
                      description={locatorPreview.warnings.join("；")}
                    />
                  ) : (
                    <Alert
                      type="success"
                      showIcon
                      message="定位规则可用"
                      description="这条规则会作为 selector_key 对应的 LocatorSpec 写回 YAML，运营同学不需要手改选择器。"
                    />
                  )}
                </>
              ) : null}
            </Space>
          ) : null}

          {businessModeReady ? (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Button type="primary" ghost disabled={!previewAvailable} loading={previewingStep} onClick={handlePreviewStep}>
                在测试页面单步试跑
              </Button>
              {stepPreview ? (
                <Descriptions
                  size="small"
                  bordered
                  column={1}
                  title="单步试跑结果"
                  items={[
                    {
                      key: "status",
                      label: "结果",
                      children: stepPreview.success ? "成功" : `失败: ${stepPreview.error_message ?? stepPreview.error_code ?? "--"}`,
                    },
                    {
                      key: "url",
                      label: "当前页面",
                      children: stepPreview.current_url ?? "--",
                    },
                    {
                      key: "title",
                      label: "页面标题",
                      children: stepPreview.page_title ?? "--",
                    },
                    {
                      key: "count",
                      label: "元素命中数",
                      children: `${stepPreview.locator_count}`,
                    },
                    {
                      key: "texts",
                      label: "样本文本",
                      children: stepPreview.matched_texts.length ? stepPreview.matched_texts.join(" / ") : "--",
                    },
                    {
                      key: "outputs",
                      label: "输出变量",
                      children: Object.keys(stepPreview.outputs).length
                        ? JSON.stringify(stepPreview.outputs, null, 2)
                        : "--",
                    },
                  ]}
                />
              ) : null}
            </Space>
          ) : null}
        </Space>
      )}
    </Drawer>
  );
}
