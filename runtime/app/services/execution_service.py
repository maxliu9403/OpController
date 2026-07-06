from __future__ import annotations

import asyncio
import base64
import random
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from string import Template
from typing import Any, Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models import StepRunRecord, StepRunStatus, TaskRunRecord, TaskRunStatus
from app.providers.base import BrowserProvider
from app.schemas.provider import ProviderSessionRef
from app.schemas.preview import LocatorLivePreviewResult, StepLivePreviewResult, WorkflowDryRunResult, WorkflowDryRunStepResult
from app.schemas.workflow import LocatorSpec, WorkflowDefinition, WorkflowStep
from app.services.monitor_service import MonitorService


class ExecutionError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class ExecutionContext:
    page: Any
    browser: Any
    workflow: WorkflowDefinition
    task_run_id: str
    row_payload: dict[str, Any]
    variables: dict[str, Any] = field(default_factory=dict)
    current_scope: Any | None = None
    child_step_handler: Callable[[WorkflowStep, "ExecutionContext"], Awaitable[None]] | None = None


class ExecutionService:
    HUMAN_STEP_PAUSE_RANGE = (0.42, 1.25)
    HUMAN_AFTER_STEP_PAUSE_RANGE = (0.65, 1.80)
    HUMAN_TARGET_PAUSE_RANGE = (0.32, 0.88)
    HUMAN_CLICK_HOLD_MS_RANGE = (85, 230)
    HUMAN_TYPE_DELAY_MS_RANGE = (95, 260)
    HUMAN_SCROLL_SEGMENT_PAUSE_RANGE = (0.22, 0.58)
    HUMAN_SCROLL_READING_PAUSE_RANGE = (0.85, 2.60)
    HUMAN_SCROLL_REVERSE_PROBABILITY = 0.45
    HUMAN_SCROLL_REVERSE_DISTANCE_RANGE = (35, 150)

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        monitor: MonitorService,
        provider_service: Any | None = None,
    ) -> None:
        self.session_factory = session_factory
        self.monitor = monitor
        self.provider_service = provider_service

    async def execute_task(
        self,
        *,
        task_run_id: str,
        workflow: WorkflowDefinition,
        provider: BrowserProvider,
        on_session_opened: Callable[[str, ProviderSessionRef], Awaitable[None]] | None = None,
        on_session_closed: Callable[[str, str], Awaitable[None]] | None = None,
    ) -> None:
        browser = None
        page = None
        playwright = None
        provider_profile_id: str | None = None
        session_opened = False
        row_payload: dict[str, Any] = {}
        async with self.session_factory() as session:
            task = await session.get(TaskRunRecord, task_run_id)
            if not task:
                raise ExecutionError("task_missing", f"Task {task_run_id} not found")
            provider_profile_id = task.provider_profile_id
            task.status = TaskRunStatus.OPENING
            task.started_at = datetime.utcnow()
            await session.commit()

            row_payload = await self._load_row_payload(session, task.batch_row_id)
        try:
            session_ref = await self._open_provider_session(provider, provider_profile_id)
            debug_endpoint = session_ref.ws_endpoint or session_ref.debugging_address
            if not debug_endpoint:
                raise ExecutionError(
                    "missing_debug_endpoint",
                    "Provider did not return a ws/debugging_address endpoint",
                )
            async with self.session_factory() as session:
                task = await session.get(TaskRunRecord, task_run_id)
                if not task:
                    raise ExecutionError("task_missing", f"Task {task_run_id} not found")
                task.provider_session_id = session_ref.provider_session_id
                task.provider_debug_endpoint = debug_endpoint
                task.status = TaskRunStatus.RUNNING
                await session.commit()
                await self._publish(
                    "task.opened",
                    {
                        "task_run_id": task.id,
                        "provider_profile_id": task.provider_profile_id,
                        "debug_endpoint": task.provider_debug_endpoint,
                    },
                )
            session_opened = True
            if on_session_opened:
                await on_session_opened(task_run_id, session_ref)

            try:
                browser, page, playwright = await asyncio.wait_for(
                    self._attach_browser(debug_endpoint),
                    timeout=settings.browser_attach_timeout_sec,
                )
            except TimeoutError as exc:
                raise ExecutionError(
                    "browser_attach_timeout",
                    f"附着浏览器调试端点超过 {settings.browser_attach_timeout_sec:.0f} 秒",
                ) from exc

            context = ExecutionContext(
                page=page,
                browser=browser,
                workflow=workflow,
                task_run_id=task_run_id,
                row_payload=row_payload,
                variables={"row": row_payload},
            )
            for step in workflow.steps:
                await self._execute_step(task_run_id, step, context)
            async with self.session_factory() as session:
                task = await session.get(TaskRunRecord, task_run_id)
                if task:
                    task.status = TaskRunStatus.SUCCEEDED
                    task.finished_at = datetime.utcnow()
                    task.outputs_json = context.variables
                    await session.commit()
        except ExecutionError as exc:
            await self._mark_task_failed(task_run_id, exc.code, exc.message)
            await self._publish(
                "task.failed",
                {"task_run_id": task_run_id, "error_code": exc.code, "message": exc.message},
            )
        except Exception as exc:  # noqa: BLE001
            await self._mark_task_failed(task_run_id, "unhandled_error", str(exc))
            await self._publish(
                "task.failed",
                {"task_run_id": task_run_id, "error_code": "unhandled_error", "message": str(exc)},
            )
        finally:
            close_pause_seconds = await self._close_pause_seconds(task_run_id, workflow)
            if close_pause_seconds > 0:
                await self._publish(
                    "task.window_kept",
                    {
                        "task_run_id": task_run_id,
                        "provider_profile_id": provider_profile_id,
                        "seconds": close_pause_seconds,
                    },
                )
                await asyncio.sleep(close_pause_seconds)
            try:
                if page:
                    await page.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                if browser:
                    await browser.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                if playwright:
                    await playwright.stop()
            except Exception:  # noqa: BLE001
                pass
            if provider_profile_id:
                try:
                    await asyncio.wait_for(
                        provider.close_profile(provider_profile_id),
                        timeout=settings.provider_close_timeout_sec,
                    )
                except Exception:  # noqa: BLE001
                    pass
                if session_opened and on_session_closed:
                    try:
                        await on_session_closed(task_run_id, provider_profile_id)
                    except Exception:  # noqa: BLE001
                        pass

    async def _open_provider_session(
        self,
        provider: BrowserProvider,
        provider_profile_id: str | None,
    ) -> ProviderSessionRef:
        if not provider_profile_id:
            raise ExecutionError("profile_missing", "Task does not have a provider profile id")
        try:
            if self.provider_service:
                open_coro = self.provider_service.open_test_session(provider.provider_type, provider_profile_id)
            else:
                open_coro = provider.open_profile(provider_profile_id)
            return await asyncio.wait_for(
                open_coro,
                timeout=settings.provider_open_timeout_sec,
            )
        except TimeoutError as exc:
            raise ExecutionError(
                "profile_open_timeout",
                f"打开 Profile {provider_profile_id} 超过 {settings.provider_open_timeout_sec:.0f} 秒，已释放槽位",
            ) from exc
        except RuntimeError as exc:
            raise ExecutionError("profile_open_failed", str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise ExecutionError("profile_open_failed", str(exc)) from exc

    async def _mark_task_failed(self, task_run_id: str, error_code: str, error_message: str) -> None:
        async with self.session_factory() as session:
            task = await session.get(TaskRunRecord, task_run_id)
            if task:
                task.status = TaskRunStatus.FAILED
                task.error_code = error_code
                task.error_message = error_message
                task.finished_at = datetime.utcnow()
                await session.commit()

    async def _publish(self, event: str, payload: dict[str, Any]) -> None:
        if self.monitor:
            await self.monitor.publish(event, payload)

    async def _close_pause_seconds(
        self,
        task_run_id: str,
        workflow: WorkflowDefinition,
    ) -> int:
        async with self.session_factory() as session:
            task = await session.get(TaskRunRecord, task_run_id)
            if not task:
                return 0
            if (
                task.status == TaskRunStatus.FAILED
                and workflow.runtime_policy.keep_window_on_failure
                and workflow.runtime_policy.keep_window_seconds > 0
            ):
                return workflow.runtime_policy.keep_window_seconds
            if (
                task.status == TaskRunStatus.SUCCEEDED
                and workflow.runtime_policy.keep_window_on_success
                and workflow.runtime_policy.keep_window_on_success_seconds > 0
            ):
                return workflow.runtime_policy.keep_window_on_success_seconds
            return 0

    async def _load_row_payload(self, session: AsyncSession, batch_row_id: str) -> dict[str, Any]:
        from app.models import BatchRowRecord

        row = await session.get(BatchRowRecord, batch_row_id)
        if not row:
            raise ExecutionError("row_missing", f"Batch row {batch_row_id} not found")
        return row.row_payload_json

    async def _attach_browser(self, endpoint: str | None) -> tuple[Any, Any, Any]:
        if not endpoint:
            raise ExecutionError("missing_debug_endpoint", "Provider did not return a debugging endpoint")
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:  # pragma: no cover - depends on optional dependency
            raise ExecutionError("playwright_missing", "Install runtime with [automation] extra") from exc

        playwright = await async_playwright().start()
        cdp_target = endpoint
        if endpoint.startswith("127.0.0.1:") or endpoint.startswith("localhost:"):
            cdp_target = f"http://{endpoint}"
        if endpoint.startswith("ws://"):
            # connect_over_cdp accepts both ws and http targets in modern Playwright builds
            cdp_target = endpoint
        browser = await playwright.chromium.connect_over_cdp(cdp_target)
        if browser.contexts:
            browser_context = browser.contexts[0]
        else:
            browser_context = await browser.new_context()
        page = browser_context.pages[0] if browser_context.pages else await browser_context.new_page()
        return browser, page, playwright

    async def preview_locator(
        self,
        *,
        endpoint: str,
        locator: LocatorSpec,
    ) -> LocatorLivePreviewResult:
        browser = None
        playwright = None
        try:
            browser, page, playwright = await self._attach_browser(endpoint)
            preview = await self._preview_locator_matches(locator_spec=locator, scope=page, allow_many=True)
            return LocatorLivePreviewResult(
                success=preview["match_count"] > 0,
                selector_used=preview["selector_used"],
                match_count=preview["match_count"],
                matched_texts=preview["matched_texts"],
                current_url=page.url,
                page_title=await page.title(),
            )
        except ExecutionError as exc:
            return LocatorLivePreviewResult(
                success=False,
                error_code=exc.code,
                error_message=exc.message,
            )
        finally:
            try:
                if browser:
                    await browser.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                if playwright:
                    await playwright.stop()
            except Exception:  # noqa: BLE001
                pass

    async def pick_locator_once(
        self,
        *,
        endpoint: str,
        timeout_sec: int = 30,
    ) -> dict[str, Any]:
        browser = None
        playwright = None
        try:
            browser, page, playwright = await self._attach_browser(endpoint)
            try:
                await page.bring_to_front()
            except Exception:  # noqa: BLE001
                pass
            picked = await self._run_locator_picker(page, timeout_sec=timeout_sec)
            picked["current_url"] = page.url
            picked["page_title"] = await page.title()
            return picked
        except ExecutionError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ExecutionError("pick_failed", str(exc)) from exc
        finally:
            try:
                if browser:
                    await browser.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                if playwright:
                    await playwright.stop()
            except Exception:  # noqa: BLE001
                pass

    async def _run_locator_picker(self, page: Any, *, timeout_sec: int) -> dict[str, Any]:
        frames = list(page.frames)
        tasks = {
            asyncio.create_task(self._pick_in_frame(frame, timeout_sec=timeout_sec)): frame
            for frame in frames
        }
        if not tasks:
            raise ExecutionError("pick_no_frame", "No browser frame is available for element picking")

        pending = set(tasks.keys())
        try:
            while pending:
                done, pending = await asyncio.wait(
                    pending,
                    timeout=timeout_sec + 2,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if not done:
                    break
                for task in done:
                    frame = tasks[task]
                    try:
                        payload = task.result()
                    except Exception:
                        continue
                    if payload.get("cancelled"):
                        continue
                    payload["frame_path"] = self._frame_path(frame)
                    payload["screenshot_data_url"] = await self._capture_picked_element(frame, payload)
                    return payload
            raise ExecutionError("pick_timeout", "等待页面点选元素超时，请重新点击“从页面点选元素”。")
        finally:
            for task in pending:
                task.cancel()
            await self._cleanup_locator_picker(frames)

    async def _pick_in_frame(self, frame: Any, *, timeout_sec: int) -> dict[str, Any]:
        try:
            return await frame.evaluate(
                self._locator_picker_script(),
                {"timeoutMs": timeout_sec * 1000},
            )
        except Exception as exc:  # noqa: BLE001
            return {"cancelled": True, "error": str(exc)}

    async def _cleanup_locator_picker(self, frames: list[Any]) -> None:
        for frame in frames:
            try:
                await frame.evaluate(
                    "() => window.__OPCTRL_PICK_CLEANUP && window.__OPCTRL_PICK_CLEANUP('cleanup')"
                )
            except Exception:  # noqa: BLE001
                pass

    async def _capture_picked_element(self, frame: Any, payload: dict[str, Any]) -> str | None:
        pick_id = payload.get("pick_id")
        if not pick_id:
            return None
        selector = f'[data-opctrl-picked-id="{pick_id}"]'
        try:
            locator = frame.locator(selector).first
            image = await locator.screenshot(timeout=3000)
            return f"data:image/png;base64,{base64.b64encode(image).decode('ascii')}"
        except Exception:  # noqa: BLE001
            return None
        finally:
            try:
                await frame.evaluate(
                    """(pickId) => {
                        const node = document.querySelector(`[data-opctrl-picked-id="${pickId}"]`);
                        if (node) node.removeAttribute("data-opctrl-picked-id");
                    }""",
                    pick_id,
                )
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _frame_path(frame: Any) -> list[str]:
        path: list[str] = []
        current = frame
        while current:
            name = current.name or "main"
            url = current.url or "about:blank"
            path.append(f"{name} | {url}")
            current = current.parent_frame
        return list(reversed(path))

    @staticmethod
    def _locator_picker_script() -> str:
        return r"""
        (params) => new Promise((resolve) => {
          const timeoutMs = params.timeoutMs || 30000;
          const doc = document;
          const win = window;
          const pickId = `opctrl-${Date.now()}-${Math.random().toString(16).slice(2)}`;

          if (win.__OPCTRL_PICK_CLEANUP) {
            try { win.__OPCTRL_PICK_CLEANUP("replaced"); } catch (_) {}
          }

          const cssEscape = (value) => {
            if (win.CSS && win.CSS.escape) return win.CSS.escape(String(value));
            return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
          };
          const quote = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim();
          const shortText = (value, max = 160) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
          const attrSelector = (name, value) => `[${name}="${quote(value)}"]`;
          const stableNames = new Set([
            "id", "name", "placeholder", "aria-label", "role", "title", "type",
            "data-testid", "data-test", "data-cy", "data-qa", "data-automation-id"
          ]);

          const style = doc.createElement("style");
          style.textContent = `
            .__opctrl-picker-box {
              position: fixed;
              z-index: 2147483646;
              pointer-events: none;
              border: 2px solid #f4a300;
              border-radius: 10px;
              box-shadow: 0 0 0 99999px rgba(2, 6, 23, 0.18), 0 14px 40px rgba(244, 163, 0, 0.28);
              background: rgba(244, 163, 0, 0.08);
              transition: transform 80ms ease, width 80ms ease, height 80ms ease;
            }
            .__opctrl-picker-label {
              position: fixed;
              z-index: 2147483647;
              pointer-events: none;
              padding: 8px 10px;
              border-radius: 999px;
              background: #111827;
              color: #fef3c7;
              font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.32);
              max-width: 360px;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }
          `;
          const box = doc.createElement("div");
          box.className = "__opctrl-picker-box";
          const label = doc.createElement("div");
          label.className = "__opctrl-picker-label";
          label.textContent = "移动鼠标选择元素，点击确认";
          doc.documentElement.append(style, box, label);

          let activeElement = null;
          let done = false;
          let timer = null;

          const cleanup = () => {
            doc.removeEventListener("mousemove", onMove, true);
            doc.removeEventListener("click", onClick, true);
            doc.removeEventListener("keydown", onKeyDown, true);
            box.remove();
            label.remove();
            style.remove();
            if (timer) clearTimeout(timer);
            win.__OPCTRL_PICK_CLEANUP = null;
          };

          const finish = (payload) => {
            if (done) return;
            done = true;
            cleanup();
            resolve(payload);
          };

          win.__OPCTRL_PICK_CLEANUP = () => finish({ cancelled: true, reason: "cleanup" });

          const eventElement = (event) => {
            const path = event.composedPath ? event.composedPath() : [];
            let node = path[0] || event.target;
            if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
            if (!(node instanceof Element)) return null;
            if (node.closest && node.closest(".__opctrl-picker-box,.__opctrl-picker-label")) return null;
            if (node === doc.documentElement || node === doc.body) return null;
            return node;
          };

          const elementText = (element) => shortText(element.innerText || element.textContent || "", 220);

          const stableAttributes = (element) => {
            const result = {};
            for (const attr of Array.from(element.attributes || [])) {
              const name = attr.name;
              const value = shortText(attr.value, 220);
              if (!value) continue;
              if (name.startsWith("data-") || stableNames.has(name)) {
                result[name] = value;
              }
            }
            return result;
          };

          const nthOfType = (element) => {
            let index = 1;
            let sibling = element.previousElementSibling;
            while (sibling) {
              if (sibling.tagName === element.tagName) index += 1;
              sibling = sibling.previousElementSibling;
            }
            return index;
          };

          const cssPath = (element) => {
            const parts = [];
            let current = element;
            while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
              const tag = current.tagName.toLowerCase();
              const id = current.getAttribute("id");
              if (id) {
                parts.unshift(`${tag}${attrSelector("id", id)}`);
                break;
              }
              const dataKey = ["data-testid", "data-test", "data-cy", "data-qa"].find((key) => current.getAttribute(key));
              if (dataKey) {
                parts.unshift(`${tag}${attrSelector(dataKey, current.getAttribute(dataKey))}`);
                break;
              }
              parts.unshift(`${tag}:nth-of-type(${nthOfType(current)})`);
              current = current.parentElement;
              if (!current || current === doc.body || current === doc.documentElement) break;
            }
            return parts.join(" > ");
          };

          const xpath = (element) => {
            const parts = [];
            let current = element;
            while (current && current.nodeType === Node.ELEMENT_NODE && current !== doc.body) {
              const tag = current.tagName.toLowerCase();
              parts.unshift(`${tag}[${nthOfType(current)}]`);
              current = current.parentElement;
            }
            return `/html/body/${parts.join("/")}`;
          };

          const neighborAnchor = (element) => {
            const previous = element.previousElementSibling ? elementText(element.previousElementSibling) : "";
            const next = element.nextElementSibling ? elementText(element.nextElementSibling) : "";
            const parent = element.parentElement ? elementText(element.parentElement) : "";
            return {
              previous_text: previous,
              next_text: next,
              parent_text: parent.slice(0, 220)
            };
          };

          const listContext = (element) => {
            const row = element.closest("tr, li, [role='row'], [data-row-key], .row, .table-row");
            if (!row) return {};
            return {
              row_tag: row.tagName.toLowerCase(),
              row_text: elementText(row),
              row_key: row.getAttribute("data-row-key") || row.getAttribute("data-id") || ""
            };
          };

          const candidateSelectors = (element, attrs, text) => {
            const tag = element.tagName.toLowerCase();
            const candidates = [];
            for (const key of ["data-testid", "data-test", "data-cy", "data-qa", "data-automation-id"]) {
              if (attrs[key]) candidates.push({ kind: "data-attribute", value: attrSelector(key, attrs[key]), score: 0.98, note: "auto-picked stable data attribute" });
            }
            if (attrs.id) candidates.push({ kind: "id", value: `${tag}${attrSelector("id", attrs.id)}`, score: 0.93, note: "auto-picked id" });
            if (attrs.name) candidates.push({ kind: "name", value: `${tag}${attrSelector("name", attrs.name)}`, score: 0.88, note: "auto-picked form name" });
            if (attrs["aria-label"]) candidates.push({ kind: "aria-label", value: `${tag}${attrSelector("aria-label", attrs["aria-label"])}`, score: 0.86, note: "auto-picked aria label" });
            if (attrs.placeholder) candidates.push({ kind: "placeholder", value: `${tag}${attrSelector("placeholder", attrs.placeholder)}`, score: 0.82, note: "auto-picked placeholder" });
            if (text) candidates.push({ kind: "tag-text", value: `${tag}:has-text("${quote(text).slice(0, 60)}")`, score: 0.81, note: "auto-picked visible text" });
            if (text) candidates.push({ kind: "text", value: `text="${quote(text).slice(0, 60)}"`, score: 0.72, note: "auto-picked text fallback" });
            const css = cssPath(element);
            if (css) candidates.push({ kind: "css-path", value: css, score: 0.58, note: "auto-picked structural fallback" });
            const xp = xpath(element);
            if (xp) candidates.push({ kind: "xpath", value: `xpath=${xp}`, score: 0.42, note: "auto-picked xpath fallback" });
            return candidates;
          };

          const describeElement = (element) => {
            const rect = element.getBoundingClientRect();
            const tag = element.tagName.toLowerCase();
            const text = elementText(element);
            const attrs = stableAttributes(element);
            element.setAttribute("data-opctrl-picked-id", pickId);
            return {
              pick_id: pickId,
              tag_name: tag,
              text,
              attributes: attrs,
              neighbor_anchor: neighborAnchor(element),
              list_context: listContext(element),
              bounding_box: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
              },
              candidate_selectors: candidateSelectors(element, attrs, text)
            };
          };

          const paint = (element) => {
            const rect = element.getBoundingClientRect();
            box.style.transform = `translate(${Math.max(rect.x, 0)}px, ${Math.max(rect.y, 0)}px)`;
            box.style.width = `${Math.max(rect.width, 4)}px`;
            box.style.height = `${Math.max(rect.height, 4)}px`;
            label.style.transform = `translate(${Math.max(rect.x, 8)}px, ${Math.max(rect.y - 38, 8)}px)`;
            label.textContent = `${element.tagName.toLowerCase()}  ${elementText(element) || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "无可见文字"}`;
          };

          function onMove(event) {
            const element = eventElement(event);
            if (!element) return;
            activeElement = element;
            paint(element);
          }

          function onClick(event) {
            const element = eventElement(event) || activeElement;
            if (!element) return;
            event.preventDefault();
            event.stopPropagation();
            finish(describeElement(element));
          }

          function onKeyDown(event) {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              finish({ cancelled: true, reason: "escape" });
            }
          }

          doc.addEventListener("mousemove", onMove, true);
          doc.addEventListener("click", onClick, true);
          doc.addEventListener("keydown", onKeyDown, true);
          timer = setTimeout(() => finish({ cancelled: true, reason: "timeout" }), timeoutMs);
        })
        """

    async def preview_step(
        self,
        *,
        endpoint: str,
        step: WorkflowStep,
        locator: LocatorSpec | None = None,
        row_payload: dict[str, Any] | None = None,
    ) -> StepLivePreviewResult:
        browser = None
        playwright = None
        artifact_path: str | None = None
        try:
            browser, page, playwright = await self._attach_browser(endpoint)
            workflow = self._build_preview_workflow(step=step, locator=locator)
            context = ExecutionContext(
                page=page,
                browser=browser,
                workflow=workflow,
                task_run_id="preview",
                row_payload=row_payload or {},
                variables={"row": row_payload or {}},
            )
            preview_before = (
                await self._preview_locator_matches(locator_spec=locator, scope=page, allow_many=self._allows_many_matches(step))
                if locator
                else {"selector_used": None, "match_count": 0, "matched_texts": []}
            )
            handler_name = f"_handle_{step.type.replace('-', '_')}"
            handler = getattr(self, handler_name, None)
            if not handler:
                raise ExecutionError("step_not_supported", f"Step type '{step.type}' cannot be previewed yet")
            await self._human_before_step(step)
            await handler(step, context)
            await self._human_after_step(step)
            if step.type == "screenshot":
                artifact_path = context.variables.get(step.save_as or "", None) if step.save_as else None
                if not artifact_path:
                    artifact_path = self._latest_manual_preview_artifact(step.id)
            return StepLivePreviewResult(
                success=True,
                current_url=page.url,
                page_title=await page.title(),
                selector_used=preview_before["selector_used"],
                locator_count=preview_before["match_count"],
                matched_texts=preview_before["matched_texts"],
                outputs={key: value for key, value in context.variables.items() if key != "row"},
                artifact_path=artifact_path,
            )
        except ExecutionError as exc:
            return StepLivePreviewResult(
                success=False,
                error_code=exc.code,
                error_message=exc.message,
                artifact_path=artifact_path,
            )
        except Exception as exc:  # noqa: BLE001
            return StepLivePreviewResult(
                success=False,
                error_code="step_exception",
                error_message=str(exc),
                artifact_path=artifact_path,
            )
        finally:
            try:
                if browser:
                    await browser.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                if playwright:
                    await playwright.stop()
            except Exception:  # noqa: BLE001
                pass

    async def preview_workflow(
        self,
        *,
        endpoint: str,
        workflow_payload: dict[str, Any],
        row_payload: dict[str, Any] | None = None,
        stop_on_failure: bool = True,
    ) -> WorkflowDryRunResult:
        browser = None
        playwright = None
        started_at = asyncio.get_running_loop().time()
        step_results: list[WorkflowDryRunStepResult] = []
        try:
            browser, page, playwright = await self._attach_browser(endpoint)
            workflow = WorkflowDefinition.model_validate(workflow_payload)

            async def child_step_handler(child_step: WorkflowStep, child_context: ExecutionContext) -> None:
                child_result = await self._preview_workflow_step(child_step, child_context)
                if child_result.status != "succeeded":
                    raise ExecutionError(child_result.error_code or "step_failed", child_result.error_message or "子步骤执行失败")

            context = ExecutionContext(
                page=page,
                browser=browser,
                workflow=workflow,
                task_run_id="dry-run",
                row_payload=row_payload or {},
                variables={"row": row_payload or {}},
                child_step_handler=child_step_handler,
            )

            for step in workflow.steps:
                result = await self._preview_workflow_step(step, context)
                step_results.append(result)
                if result.status != "succeeded" and stop_on_failure:
                    break

            failed_steps = [step for step in step_results if step.status != "succeeded"]
            return WorkflowDryRunResult(
                success=not failed_steps and len(step_results) == len(workflow.steps),
                total_steps=len(workflow.steps),
                succeeded_steps=len([step for step in step_results if step.status == "succeeded"]),
                failed_steps=len(failed_steps),
                elapsed_ms=int((asyncio.get_running_loop().time() - started_at) * 1000),
                current_url=page.url,
                page_title=await page.title(),
                outputs={key: value for key, value in context.variables.items() if key != "row"},
                steps=step_results,
                error_code=failed_steps[0].error_code if failed_steps else None,
                error_message=failed_steps[0].error_message if failed_steps else None,
            )
        except ExecutionError as exc:
            return WorkflowDryRunResult(
                success=False,
                total_steps=len(step_results),
                succeeded_steps=len([step for step in step_results if step.status == "succeeded"]),
                failed_steps=max(1, len([step for step in step_results if step.status != "succeeded"])),
                elapsed_ms=int((asyncio.get_running_loop().time() - started_at) * 1000),
                steps=step_results,
                error_code=exc.code,
                error_message=exc.message,
            )
        except Exception as exc:  # noqa: BLE001
            return WorkflowDryRunResult(
                success=False,
                total_steps=len(step_results),
                succeeded_steps=len([step for step in step_results if step.status == "succeeded"]),
                failed_steps=max(1, len([step for step in step_results if step.status != "succeeded"])),
                elapsed_ms=int((asyncio.get_running_loop().time() - started_at) * 1000),
                steps=step_results,
                error_code="workflow_preview_exception",
                error_message=str(exc),
            )
        finally:
            try:
                if browser:
                    await browser.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                if playwright:
                    await playwright.stop()
            except Exception:  # noqa: BLE001
                pass

    async def _preview_workflow_step(
        self,
        step: WorkflowStep,
        context: ExecutionContext,
    ) -> WorkflowDryRunStepResult:
        started_at = asyncio.get_running_loop().time()
        artifact_path: str | None = None
        preview = {"selector_used": None, "match_count": 0, "matched_texts": []}
        preview_error: dict[str, str] | None = None
        try:
            locator = self._lookup_locator(step, context.workflow)
            if locator:
                try:
                    preview = await self._preview_locator_matches(
                        locator_spec=locator,
                        scope=context.current_scope or context.page,
                        allow_many=self._allows_many_matches(step),
                    )
                except ExecutionError as exc:
                    preview_error = {"error_code": exc.code, "message": exc.message}

            handler_name = f"_handle_{step.type.replace('-', '_')}"
            handler = getattr(self, handler_name, None)
            if not handler:
                raise ExecutionError("step_not_supported", f"Step type '{step.type}' cannot be previewed yet")
            await self._human_before_step(step)
            await handler(step, context)
            await self._human_after_step(step)
            if step.type == "screenshot":
                artifact_path = context.variables.get(step.save_as or "", None) if step.save_as else None
                if not artifact_path:
                    artifact_path = self._latest_manual_preview_artifact(step.id)
            outputs = self._step_output_summary(step, context)
            if preview_error:
                outputs = {**outputs, "locator_preview_warning": preview_error}
            return WorkflowDryRunStepResult(
                step_id=step.id,
                label=step.label,
                action_type=step.type,
                status="succeeded",
                elapsed_ms=int((asyncio.get_running_loop().time() - started_at) * 1000),
                selector_used=preview["selector_used"],
                locator_count=preview["match_count"],
                matched_texts=preview["matched_texts"],
                outputs=outputs,
                current_url=context.page.url,
                page_title=await context.page.title(),
                artifact_path=artifact_path,
            )
        except ExecutionError as exc:
            return WorkflowDryRunStepResult(
                step_id=step.id,
                label=step.label,
                action_type=step.type,
                status="failed",
                elapsed_ms=int((asyncio.get_running_loop().time() - started_at) * 1000),
                selector_used=preview["selector_used"],
                locator_count=preview["match_count"],
                matched_texts=preview["matched_texts"],
                current_url=context.page.url if context.page else None,
                page_title=await self._safe_page_title(context.page),
                artifact_path=artifact_path,
                error_code=exc.code,
                error_message=exc.message,
            )
        except Exception as exc:  # noqa: BLE001
            return WorkflowDryRunStepResult(
                step_id=step.id,
                label=step.label,
                action_type=step.type,
                status="failed",
                elapsed_ms=int((asyncio.get_running_loop().time() - started_at) * 1000),
                selector_used=preview["selector_used"],
                locator_count=preview["match_count"],
                matched_texts=preview["matched_texts"],
                current_url=context.page.url if context.page else None,
                page_title=await self._safe_page_title(context.page),
                artifact_path=artifact_path,
                error_code="step_exception",
                error_message=str(exc),
            )

    @staticmethod
    async def _safe_page_title(page: Any) -> str | None:
        try:
            return await page.title() if page else None
        except Exception:  # noqa: BLE001
            return None

    async def _execute_step(
        self,
        task_run_id: str,
        step: WorkflowStep,
        context: ExecutionContext,
    ) -> None:
        step_run_id = await self._create_step_run(task_run_id, step)
        try:
            handler_name = f"_handle_{step.type.replace('-', '_')}"
            handler = getattr(self, handler_name, None)
            if not handler:
                raise ExecutionError("step_not_supported", f"Step type '{step.type}' is not supported yet")
            await self._human_before_step(step)
            await handler(step, context)
            await self._human_after_step(step)
            await self._finish_step_run(
                step_run_id,
                StepRunStatus.SUCCEEDED,
                output=self._step_output_summary(step, context),
                locator_summary=self._locator_summary(step, context.workflow),
            )
        except ExecutionError as exc:
            screenshot_path = None
            if context.workflow.runtime_policy.screenshot_on_failure:
                screenshot_path = await self._capture_failure_screenshot(context, task_run_id, step.id)
            await self._finish_step_run(
                step_run_id,
                StepRunStatus.FAILED,
                error_code=exc.code,
                error_message=exc.message,
                artifact_path=screenshot_path,
                locator_summary=self._locator_summary(step, context.workflow),
            )
            raise
        except Exception as exc:  # noqa: BLE001
            screenshot_path = None
            if context.workflow.runtime_policy.screenshot_on_failure:
                screenshot_path = await self._capture_failure_screenshot(context, task_run_id, step.id)
            await self._finish_step_run(
                step_run_id,
                StepRunStatus.FAILED,
                error_code="step_exception",
                error_message=str(exc),
                artifact_path=screenshot_path,
                locator_summary=self._locator_summary(step, context.workflow),
            )
            raise ExecutionError("step_exception", str(exc)) from exc

    async def _create_step_run(self, task_run_id: str, step: WorkflowStep) -> str:
        async with self.session_factory() as session:
            record = StepRunRecord(
                task_run_id=task_run_id,
                step_id=step.id,
                label=step.label,
                action_type=step.type,
                status=StepRunStatus.RUNNING,
                started_at=datetime.utcnow(),
            )
            session.add(record)
            await session.commit()
            return record.id

    async def _finish_step_run(
        self,
        step_run_id: str,
        status: StepRunStatus,
        *,
        output: Any = None,
        error_code: str | None = None,
        error_message: str | None = None,
        artifact_path: str | None = None,
        locator_summary: dict[str, Any] | None = None,
    ) -> None:
        async with self.session_factory() as session:
            record = await session.get(StepRunRecord, step_run_id)
            if not record:
                return
            record.status = status
            record.finished_at = datetime.utcnow()
            if output is not None:
                record.output_payload_json = output if isinstance(output, dict) else {"value": output}
            if error_code:
                record.error_code = error_code
            if error_message:
                record.error_message = error_message
            if artifact_path:
                record.artifact_path = artifact_path
            if locator_summary:
                record.locator_summary_json = locator_summary
            await session.commit()

    def _step_output_summary(self, step: WorkflowStep, context: ExecutionContext) -> dict[str, Any]:
        if step.save_as:
            return {"value": context.variables.get(step.save_as)}
        if step.type == "wait":
            return context.variables.get("last_wait", {})
        if step.type == "click":
            if self._is_random_many_click(step):
                return context.variables.get("last_random_click", {})
            return context.variables.get("last_click", {})
        if step.type == "fill":
            return context.variables.get("last_fill", {})
        if step.type == "select":
            return context.variables.get("last_select", {})
        if step.type == "goto":
            return context.variables.get("last_goto", {})
        if step.type == "sleep":
            return context.variables.get("last_sleep", {})
        if step.type == "scroll":
            return context.variables.get("last_scroll", {})
        return {}

    async def _capture_failure_screenshot(
        self,
        context: ExecutionContext,
        task_run_id: str,
        step_id: str,
    ) -> str | None:
        if not context.page:
            return None
        output_dir = settings.artifact_dir / "screenshots" / task_run_id
        output_dir.mkdir(parents=True, exist_ok=True)
        screenshot_path = output_dir / f"{step_id}.png"
        await context.page.screenshot(path=str(screenshot_path), full_page=True)
        return str(screenshot_path)

    def _locator_summary(self, step: WorkflowStep, workflow: WorkflowDefinition) -> dict[str, Any]:
        locator = self._lookup_locator(step, workflow)
        if not locator:
            return {}
        return {
            "primary_selector": locator.primary_selector,
            "fallback_selectors": locator.fallback_selectors,
            "stability_score": locator.stability_score,
        }

    def _lookup_locator(self, step: WorkflowStep, workflow: WorkflowDefinition) -> LocatorSpec | None:
        if step.selector_key and step.selector_key in workflow.locators:
            return workflow.locators[step.selector_key]
        if step.selector:
            return LocatorSpec(primary_selector=step.selector, stability_score=0.4)
        return None

    def _selectors_for_step(self, step: WorkflowStep, workflow: WorkflowDefinition) -> list[str]:
        locator_spec = self._lookup_locator(step, workflow)
        return self._selectors_from_locator_spec(locator_spec, fallback_selector=step.selector)

    @classmethod
    def _selectors_from_locator_spec(
        cls,
        locator_spec: LocatorSpec | None,
        *,
        fallback_selector: str | None = None,
    ) -> list[str]:
        selectors: list[str] = []
        if locator_spec:
            selectors.extend(cls._semantic_selectors_from_locator(locator_spec))
            selectors.extend(
                candidate.value
                for candidate in sorted(locator_spec.candidates, key=lambda item: item.score, reverse=True)
            )
            selectors.extend([locator_spec.primary_selector, *locator_spec.fallback_selectors])
        if fallback_selector:
            selectors.append(fallback_selector)
        return cls._dedupe_selectors(selectors)

    @classmethod
    def _semantic_selectors_from_locator(cls, locator_spec: LocatorSpec) -> list[str]:
        attrs = locator_spec.attribute_signature or {}
        text = str(locator_spec.text_signature.get("normalized") or "").strip()
        tag_name = cls._safe_selector_tag(locator_spec.tag_name)
        selectors: list[str] = []

        if text:
            for keys in [
                ("data-testid",),
                ("data-test",),
                ("data-cy",),
                ("data-qa",),
                ("data-automation-id",),
                ("data-et-name", "data-et-prop-content_type"),
                ("data-et-name",),
                ("data-et-prop-content_type",),
                ("data-et-prop-location",),
                ("data-et-element-type",),
            ]:
                selector = cls._attribute_text_selector(tag_name, attrs, keys, text)
                if selector:
                    selectors.append(selector)
            selectors.append(f'{tag_name}:has-text("{cls._escape_selector_text(text)}")')

        for key in [
            "data-testid",
            "data-test",
            "data-cy",
            "data-qa",
            "data-automation-id",
            "data-et-name",
            "data-et-prop-content_type",
            "data-et-prop-location",
        ]:
            value = attrs.get(key)
            if value:
                selectors.append(f'{tag_name}[{key}="{cls._escape_selector_attr(value)}"]')

        return cls._dedupe_selectors(selectors)

    @classmethod
    def _attribute_text_selector(
        cls,
        tag_name: str,
        attrs: dict[str, Any],
        keys: tuple[str, ...],
        text: str,
    ) -> str | None:
        parts: list[str] = []
        for key in keys:
            value = attrs.get(key)
            if not value:
                return None
            parts.append(f'[{key}="{cls._escape_selector_attr(value)}"]')
        return f'{tag_name}{"".join(parts)}:has-text("{cls._escape_selector_text(text)}")'

    @staticmethod
    def _safe_selector_tag(tag_name: str | None) -> str:
        normalized = (tag_name or "*").strip().lower()
        if not normalized or normalized == "*":
            return "*"
        if all(char.isalnum() or char in {"-", "_"} for char in normalized):
            return normalized
        return "*"

    @staticmethod
    def _escape_selector_attr(value: Any) -> str:
        return str(value).replace("\\", "\\\\").replace('"', '\\"')

    @staticmethod
    def _escape_selector_text(value: Any) -> str:
        return " ".join(str(value).split()).replace("\\", "\\\\").replace('"', '\\"')

    @staticmethod
    def _dedupe_selectors(selectors: list[str]) -> list[str]:
        seen: set[str] = set()
        result: list[str] = []
        for selector in selectors:
            normalized = str(selector or "").strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            result.append(normalized)
        return result

    def _render_value(self, template_value: Any, context: ExecutionContext) -> Any:
        if not isinstance(template_value, str):
            return template_value
        variables = {
            "row": context.row_payload,
            "step": context.variables.get("step", {}),
            **context.variables,
        }
        rendered = template_value
        for namespace, value in variables.items():
            if isinstance(value, dict):
                for key, inner in value.items():
                    rendered = rendered.replace(f"${{{namespace}.{key}}}", str(inner))
        return Template(rendered).safe_substitute({})

    async def _resolve_locator(
        self,
        step: WorkflowStep,
        context: ExecutionContext,
        *,
        allow_many: bool = False,
        timeout_ms: int | None = None,
    ) -> Any:
        locator_spec = self._lookup_locator(step, context.workflow)
        scope = context.current_scope or context.page
        resolved = await self._resolve_locator_from_spec(
            locator_spec=locator_spec,
            fallback_selector=step.selector,
            scope=scope,
            step_id=step.id,
            allow_many=allow_many,
            timeout_ms=timeout_ms,
        )
        context.variables["_last_locator_resolution"] = self._locator_resolution_summary(resolved)
        return resolved["locator"]

    @staticmethod
    def _locator_resolution_summary(resolved: dict[str, Any]) -> dict[str, Any]:
        return {
            key: value
            for key, value in resolved.items()
            if key != "locator"
        }

    async def _human_before_step(self, step: WorkflowStep) -> None:
        # Passive waits already spend most of their time observing the page.
        if step.type in {"wait", "wait_visible", "sleep"}:
            await self._human_pause(0.18, 0.42)
            return
        await self._human_pause(*self.HUMAN_STEP_PAUSE_RANGE)

    async def _human_after_step(self, step: WorkflowStep) -> None:
        if step.type == "sleep":
            await self._human_pause(0.18, 0.45)
            return
        await self._human_pause(*self.HUMAN_AFTER_STEP_PAUSE_RANGE)

    @staticmethod
    async def _human_pause(min_seconds: float, max_seconds: float) -> None:
        if max_seconds <= 0:
            return
        lower = max(0.0, min(min_seconds, max_seconds))
        upper = max(lower, max_seconds)
        await asyncio.sleep(random.uniform(lower, upper))

    async def _prepare_target_for_action(self, target: Any, *, timeout_ms: int) -> None:
        scroll = getattr(target, "scroll_into_view_if_needed", None)
        if callable(scroll):
            try:
                await scroll(timeout=min(timeout_ms, 5000))
            except Exception:  # noqa: BLE001
                pass
        hover = getattr(target, "hover", None)
        if callable(hover):
            try:
                await hover(timeout=min(timeout_ms, 5000))
            except TypeError:
                try:
                    await hover()
                except Exception:  # noqa: BLE001
                    pass
            except Exception:  # noqa: BLE001
                pass
        await self._human_pause(*self.HUMAN_TARGET_PAUSE_RANGE)

    async def _humanized_click(self, target: Any, *, page: Any | None = None, timeout_ms: int) -> dict[str, Any]:
        await self._prepare_target_for_action(target, timeout_ms=timeout_ms)
        hold_ms = random.randint(*self.HUMAN_CLICK_HOLD_MS_RANGE)
        before_url = self._safe_page_url(page)
        try:
            await target.click(timeout=timeout_ms, delay=hold_ms)
        except TypeError:
            await target.click(timeout=timeout_ms)
        navigation = await self._wait_after_possible_same_tab_navigation(
            page,
            before_url=before_url,
            timeout_ms=timeout_ms,
        )
        await self._human_pause(0.38, 1.05)
        return {"click_hold_ms": hold_ms, **navigation}

    @staticmethod
    def _safe_page_url(page: Any | None) -> str | None:
        try:
            return str(page.url) if page else None
        except Exception:  # noqa: BLE001
            return None

    async def _wait_after_possible_same_tab_navigation(
        self,
        page: Any | None,
        *,
        before_url: str | None,
        timeout_ms: int,
    ) -> dict[str, Any]:
        if not page or not before_url:
            return {"navigation_detected": False, "url_before": before_url, "url_after": before_url}
        wait_for_load_state = getattr(page, "wait_for_load_state", None)
        if not callable(wait_for_load_state):
            return {"navigation_detected": False, "url_before": before_url, "url_after": self._safe_page_url(page)}

        detect_deadline = asyncio.get_running_loop().time() + min(max(timeout_ms / 1000 * 0.4, 2.5), 6.0)
        after_url = self._safe_page_url(page)
        navigation_detected = after_url is not None and after_url != before_url
        while not navigation_detected and asyncio.get_running_loop().time() < detect_deadline:
            await asyncio.sleep(0.2)
            after_url = self._safe_page_url(page)
            navigation_detected = after_url is not None and after_url != before_url

        if not navigation_detected:
            return {"navigation_detected": False, "url_before": before_url, "url_after": after_url}

        started_at = asyncio.get_running_loop().time()
        checkpoints: dict[str, Any] = {}
        for state, max_wait_ms in [("domcontentloaded", 5000), ("load", 5000), ("networkidle", 3500)]:
            try:
                await page.wait_for_load_state(state, timeout=min(max_wait_ms, max(1, timeout_ms)))
                checkpoints[state] = True
            except Exception:  # noqa: BLE001
                checkpoints[state] = False
        checkpoints["page_stable"] = await self._wait_page_stable_probe(page, timeout_ms=min(timeout_ms, 6000))
        return {
            "navigation_detected": True,
            "url_before": before_url,
            "url_after": self._safe_page_url(page),
            "navigation_wait_ms": int((asyncio.get_running_loop().time() - started_at) * 1000),
            "navigation_checkpoints": checkpoints,
        }

    async def _wait_page_stable_probe(self, page: Any, *, timeout_ms: int, stable_ms: int = 900) -> bool:
        deadline = asyncio.get_running_loop().time() + max(0.5, timeout_ms / 1000)
        stable_required = stable_ms / 1000
        last_signature: dict[str, Any] | None = None
        stable_since = asyncio.get_running_loop().time()
        while asyncio.get_running_loop().time() < deadline:
            try:
                signature = await page.evaluate(
                    """() => ({
                        url: location.href,
                        readyState: document.readyState,
                        nodeCount: document.querySelectorAll("*").length,
                        bodyTextLength: document.body ? document.body.innerText.length : 0,
                        scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0
                    })"""
                )
            except Exception:  # noqa: BLE001
                await asyncio.sleep(0.2)
                continue
            now = asyncio.get_running_loop().time()
            if signature == last_signature:
                if now - stable_since >= stable_required:
                    return True
            else:
                last_signature = signature
                stable_since = now
            await asyncio.sleep(0.25)
        return False

    async def _humanized_fill(self, target: Any, value: str, *, timeout_ms: int) -> dict[str, Any]:
        await self._prepare_target_for_action(target, timeout_ms=timeout_ms)
        try:
            await target.click(timeout=timeout_ms, delay=random.randint(35, 95))
        except TypeError:
            try:
                await target.click(timeout=timeout_ms)
            except Exception:  # noqa: BLE001
                pass
        await self._human_pause(0.22, 0.64)
        try:
            await target.fill("", timeout=timeout_ms)
        except TypeError:
            await target.fill("")
        delay_ms = random.randint(*self.HUMAN_TYPE_DELAY_MS_RANGE)
        typed_with = "press_sequentially"
        try:
            press_sequentially = getattr(target, "press_sequentially", None)
            if callable(press_sequentially):
                await press_sequentially(value, delay=delay_ms, timeout=timeout_ms)
            else:
                typed_with = "type"
                await target.type(value, delay=delay_ms, timeout=timeout_ms)
        except AttributeError:
            typed_with = "fill"
            await target.fill(value, timeout=timeout_ms)
        except TypeError:
            typed_with = "fill"
            await target.fill(value, timeout=timeout_ms)
        return {"input_method": typed_with, "per_char_delay_ms": delay_ms}

    async def _handle_goto(self, step: WorkflowStep, context: ExecutionContext) -> None:
        if not step.url:
            raise ExecutionError("missing_url", f"Step '{step.id}' is missing url")
        timeout_ms = (step.timeout_sec or context.workflow.runtime_policy.page_timeout_sec) * 1000
        started_at = asyncio.get_running_loop().time()
        await context.page.goto(
            self._render_value(step.url, context),
            wait_until="domcontentloaded",
            timeout=timeout_ms,
        )
        context.variables["last_goto"] = {
            "url": context.page.url,
            "elapsed_ms": int((asyncio.get_running_loop().time() - started_at) * 1000),
            "humanized": True,
        }

    async def _handle_click(self, step: WorkflowStep, context: ExecutionContext) -> None:
        timeout_ms = (step.timeout_sec or context.workflow.runtime_policy.step_timeout_sec) * 1000
        if self._is_random_many_click(step):
            try:
                locator = await self._resolve_locator(
                    step,
                    context,
                    allow_many=True,
                    timeout_ms=timeout_ms,
                )
            except ExecutionError as exc:
                if exc.code != "locator_missing":
                    raise
                context.variables["last_random_click"] = {
                    "matched_count": 0,
                    "requested_count": step.random_click_count,
                    "clicked_count": 0,
                    "clicked_indices": [],
                    "skipped": True,
                    "skip_reason": exc.message,
                }
                return
            count = await locator.count()
            if count <= 0:
                context.variables["last_random_click"] = {
                    "matched_count": 0,
                    "requested_count": step.random_click_count,
                    "clicked_count": 0,
                    "clicked_indices": [],
                    "skipped": True,
                    "skip_reason": "random_many locator matched no elements",
                }
                return
            click_count = min(max(step.random_click_count, 1), count)
            clicked_indices = self._random_indices(total=count, requested=click_count)
            click_results: list[dict[str, Any]] = []
            for index in clicked_indices:
                click_result = await self._humanized_click(
                    locator.nth(index),
                    page=context.page,
                    timeout_ms=timeout_ms,
                )
                click_results.append(click_result)
                if click_result.get("navigation_detected"):
                    break
                await self._human_pause(0.28, 0.95)
            context.variables["last_random_click"] = {
                "matched_count": count,
                "requested_count": step.random_click_count,
                "clicked_count": len(click_results),
                "clicked_indices": clicked_indices[: len(click_results)],
                "click_hold_ms": [result.get("click_hold_ms") for result in click_results],
                "click_results": click_results,
                "locator_resolution": context.variables.get("_last_locator_resolution", {}),
                "stopped_after_navigation": any(result.get("navigation_detected") for result in click_results),
                "humanized": True,
            }
            return

        locator = await self._resolve_locator(step, context, timeout_ms=timeout_ms)
        click_result = await self._humanized_click(locator, page=context.page, timeout_ms=timeout_ms)
        context.variables["last_click"] = {
            "clicked_count": 1,
            "click_hold_ms": click_result.get("click_hold_ms"),
            "locator_resolution": context.variables.get("_last_locator_resolution", {}),
            "humanized": True,
            **click_result,
        }

    async def _handle_fill(self, step: WorkflowStep, context: ExecutionContext) -> None:
        timeout_ms = (step.timeout_sec or context.workflow.runtime_policy.step_timeout_sec) * 1000
        locator = await self._resolve_locator(step, context, timeout_ms=timeout_ms)
        value = self._render_value(step.value, context)
        humanized = await self._humanized_fill(locator, str(value), timeout_ms=timeout_ms)
        context.variables["last_fill"] = {"filled": True, "value_length": len(str(value)), "humanized": True, **humanized}

    async def _handle_select(self, step: WorkflowStep, context: ExecutionContext) -> None:
        timeout_ms = (step.timeout_sec or context.workflow.runtime_policy.step_timeout_sec) * 1000
        locator = await self._resolve_locator(step, context, timeout_ms=timeout_ms)
        value = self._render_value(step.value, context)
        await self._prepare_target_for_action(locator, timeout_ms=timeout_ms)
        await locator.select_option(str(value), timeout=timeout_ms)
        await self._human_pause(0.18, 0.46)
        context.variables["last_select"] = {"selected": True, "value": str(value), "humanized": True}

    async def _handle_hover(self, step: WorkflowStep, context: ExecutionContext) -> None:
        timeout_ms = (step.timeout_sec or context.workflow.runtime_policy.step_timeout_sec) * 1000
        locator = await self._resolve_locator(step, context, timeout_ms=timeout_ms)
        await self._prepare_target_for_action(locator, timeout_ms=timeout_ms)
        await locator.hover(timeout=timeout_ms)
        await self._human_pause(0.18, 0.50)

    async def _handle_wait_visible(self, step: WorkflowStep, context: ExecutionContext) -> None:
        wait_step = step.model_copy(update={"wait_mode": "element_visible"})
        await self._handle_wait(wait_step, context)

    async def _handle_wait(self, step: WorkflowStep, context: ExecutionContext) -> None:
        wait_mode = step.wait_mode or "element_visible"
        timeout_ms = (step.timeout_sec or context.workflow.runtime_policy.step_timeout_sec) * 1000
        if self._should_upgrade_wait_to_page_ready(step, context.workflow):
            wait_mode = "page_ready"
        started_at = asyncio.get_running_loop().time()
        try:
            if wait_mode == "page_ready":
                output = await self._wait_page_ready(step, context, timeout_ms=timeout_ms)
            elif wait_mode == "element_visible":
                output = await self._wait_element_visible(step, context, timeout_ms=timeout_ms)
            elif wait_mode == "element_hidden":
                output = await self._wait_element_hidden(step, context, timeout_ms=timeout_ms)
            elif wait_mode == "element_count":
                output = await self._wait_element_count(step, context, timeout_ms=timeout_ms)
            elif wait_mode == "page_stable":
                output = await self._wait_page_stable(step, context, timeout_ms=timeout_ms)
            else:
                raise ExecutionError("wait_mode_unsupported", f"Wait mode '{wait_mode}' is not supported")
            context.variables["last_wait"] = {
                "mode": wait_mode,
                "success": True,
                "elapsed_ms": int((asyncio.get_running_loop().time() - started_at) * 1000),
                **output,
            }
        except ExecutionError as exc:
            if self._should_continue_on_timeout(step, exc):
                warning = {
                    "step_id": step.id,
                    "mode": wait_mode,
                    "error_code": exc.code,
                    "message": exc.message,
                    "elapsed_ms": int((asyncio.get_running_loop().time() - started_at) * 1000),
                }
                context.variables.setdefault("wait_warnings", []).append(warning)
                context.variables["last_wait"] = {"mode": wait_mode, "success": False, **warning}
                return
            raise

    def _should_upgrade_wait_to_page_ready(self, step: WorkflowStep, workflow: WorkflowDefinition) -> bool:
        if step.type != "wait" or (step.wait_mode or "element_visible") != "element_visible":
            return False
        locator = self._lookup_locator(step, workflow)
        if not locator:
            return False
        label_text = f"{step.label or ''} {locator.primary_selector} {locator.text_signature.get('normalized', '')}"
        looks_like_page_wait = "页面" in label_text and ("等待" in label_text or "就绪" in label_text)
        broad_fallback = "div" in locator.fallback_selectors or locator.primary_selector == "div"
        weak_locator = locator.stability_score < 0.5 or broad_fallback
        return looks_like_page_wait and weak_locator

    async def _wait_page_ready(
        self,
        step: WorkflowStep,
        context: ExecutionContext,
        *,
        timeout_ms: int,
    ) -> dict[str, Any]:
        deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
        checkpoints: dict[str, Any] = {}
        await self._wait_load_state(context.page, "domcontentloaded", deadline, checkpoints)
        await self._wait_load_state(context.page, "load", deadline, checkpoints)
        checkpoints["document_ready_state"] = await self._wait_document_complete(context.page, deadline)
        try:
            await context.page.wait_for_load_state("networkidle", timeout=min(self._remaining_ms(deadline), 5000))
            checkpoints["network_idle"] = True
        except Exception:  # noqa: BLE001
            checkpoints["network_idle"] = False
        checkpoints["loading_indicators"] = await self._wait_loading_indicators_hidden(context.page, deadline)
        stable = await self._wait_page_stable(step, context, timeout_ms=self._remaining_ms(deadline))
        return {"checkpoints": checkpoints, **stable}

    async def _wait_load_state(
        self,
        page: Any,
        state: str,
        deadline: float,
        checkpoints: dict[str, Any],
    ) -> None:
        try:
            await page.wait_for_load_state(state, timeout=self._remaining_ms(deadline))
            checkpoints[state] = True
        except Exception as exc:  # noqa: BLE001
            raise ExecutionError("wait_timeout", f"Timed out waiting for page load state '{state}'") from exc

    async def _wait_document_complete(self, page: Any, deadline: float) -> str:
        while True:
            state = await page.evaluate("() => document.readyState")
            if state == "complete":
                return state
            if asyncio.get_running_loop().time() >= deadline:
                raise ExecutionError("wait_timeout", "Timed out waiting for document.readyState=complete")
            await asyncio.sleep(0.25)

    async def _wait_loading_indicators_hidden(self, page: Any, deadline: float) -> dict[str, Any]:
        last_visible: dict[str, Any] = {"count": 0, "examples": []}
        while True:
            visible = await page.evaluate(
                """() => {
                    const selectors = [
                        '[aria-busy="true"]',
                        '[data-loading="true"]',
                        '[data-testid*="loading" i]',
                        '[data-testid*="skeleton" i]',
                        '[class*="loading" i]',
                        '[class*="loader" i]',
                        '[class*="spinner" i]',
                        '[class*="skeleton" i]',
                        '[class*="shimmer" i]'
                    ];
                    const seen = new Set();
                    const examples = [];
                    let count = 0;
                    const isVisible = (node) => {
                        const style = window.getComputedStyle(node);
                        const rect = node.getBoundingClientRect();
                        return style.visibility !== 'hidden' &&
                            style.display !== 'none' &&
                            Number(style.opacity || 1) > 0 &&
                            rect.width > 0 &&
                            rect.height > 0;
                    };
                    for (const selector of selectors) {
                        for (const node of document.querySelectorAll(selector)) {
                            if (seen.has(node) || !isVisible(node)) continue;
                            seen.add(node);
                            count += 1;
                            if (examples.length < 3) {
                                examples.push({
                                    selector,
                                    tag: node.tagName.toLowerCase(),
                                    text: (node.innerText || node.getAttribute('aria-label') || '').slice(0, 80)
                                });
                            }
                        }
                    }
                    return { count, examples };
                }"""
            )
            last_visible = visible
            if int(visible.get("count") or 0) == 0:
                return visible
            if asyncio.get_running_loop().time() >= deadline:
                raise ExecutionError(
                    "wait_timeout",
                    f"Timed out waiting for loading indicators to disappear: {last_visible}",
                )
            await asyncio.sleep(0.25)

    @staticmethod
    def _remaining_ms(deadline: float) -> int:
        return max(1, int((deadline - asyncio.get_running_loop().time()) * 1000))

    async def _wait_element_visible(
        self,
        step: WorkflowStep,
        context: ExecutionContext,
        *,
        timeout_ms: int,
    ) -> dict[str, Any]:
        locator = await self._resolve_locator(step, context, allow_many=True, timeout_ms=timeout_ms)
        await locator.first.wait_for(state="visible", timeout=timeout_ms)
        return {"matched_count": await locator.count()}

    async def _wait_element_hidden(
        self,
        step: WorkflowStep,
        context: ExecutionContext,
        *,
        timeout_ms: int,
    ) -> dict[str, Any]:
        selectors = self._selectors_for_step(step, context.workflow)
        if not selectors:
            raise ExecutionError("missing_locator", f"Step '{step.id}' does not define a locator")
        scope = context.current_scope or context.page
        deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
        last_visible_count = 0
        while True:
            visible_count = 0
            for selector in selectors:
                locator = scope.locator(selector)
                count = await locator.count()
                for index in range(count):
                    try:
                        if await locator.nth(index).is_visible(timeout=300):
                            visible_count += 1
                    except Exception:  # noqa: BLE001
                        continue
            if visible_count == 0:
                return {"visible_count": 0}
            last_visible_count = visible_count
            if asyncio.get_running_loop().time() >= deadline:
                raise ExecutionError(
                    "wait_timeout",
                    f"Step '{step.id}' waited for hidden elements, but {last_visible_count} remained visible",
                )
            await asyncio.sleep(0.25)

    async def _wait_element_count(
        self,
        step: WorkflowStep,
        context: ExecutionContext,
        *,
        timeout_ms: int,
    ) -> dict[str, Any]:
        selectors = self._selectors_for_step(step, context.workflow)
        if not selectors:
            raise ExecutionError("missing_locator", f"Step '{step.id}' does not define a locator")
        scope = context.current_scope or context.page
        deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
        target_count = max(0, step.min_count)
        last_count = 0
        while True:
            for selector in selectors:
                count = await scope.locator(selector).count()
                last_count = max(last_count, count)
                if count >= target_count:
                    return {"matched_count": count, "min_count": target_count, "selector_used": selector}
            if asyncio.get_running_loop().time() >= deadline:
                raise ExecutionError(
                    "wait_timeout",
                    f"Step '{step.id}' waited for at least {target_count} elements, but only saw {last_count}",
                )
            await asyncio.sleep(0.25)

    async def _wait_page_stable(
        self,
        step: WorkflowStep,
        context: ExecutionContext,
        *,
        timeout_ms: int,
    ) -> dict[str, Any]:
        stable_required = step.stable_ms / 1000
        deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
        last_signature: dict[str, Any] | None = None
        stable_since = asyncio.get_running_loop().time()
        while True:
            signature = await context.page.evaluate(
                """() => ({
                    readyState: document.readyState,
                    bodyTextLength: document.body ? document.body.innerText.length : 0,
                    nodeCount: document.querySelectorAll("*").length,
                    scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
                    url: location.href
                })"""
            )
            now = asyncio.get_running_loop().time()
            if signature == last_signature:
                if now - stable_since >= stable_required:
                    return {"stable_ms": step.stable_ms, "signature": signature}
            else:
                last_signature = signature
                stable_since = now
            if now >= deadline:
                raise ExecutionError("wait_timeout", f"Step '{step.id}' waited for page stability but timed out")
            await asyncio.sleep(0.25)

    @staticmethod
    def _should_continue_on_timeout(step: WorkflowStep, exc: ExecutionError) -> bool:
        if step.optional:
            return True
        if exc.code in {"wait_timeout", "locator_missing"}:
            return step.on_timeout in {"continue", "continue_with_warning", "warn"}
        return False

    async def _handle_wait_text(self, step: WorkflowStep, context: ExecutionContext) -> None:
        timeout_ms = (step.timeout_sec or context.workflow.runtime_policy.step_timeout_sec) * 1000
        locator = await self._resolve_locator(step, context, timeout_ms=timeout_ms)
        await locator.wait_for(
            state="visible",
            timeout=timeout_ms,
        )
        text = await locator.text_content()
        expected = self._render_value(step.text or "", context)
        if expected not in (text or ""):
            raise ExecutionError("text_mismatch", f"Expected '{expected}' in locator text")

    async def _handle_scroll(self, step: WorkflowStep, context: ExecutionContext) -> None:
        legacy_delta = step.value if step.value is not None else None
        direction = (step.scroll_direction or "down").lower()
        distance = abs(int(self._render_value(step.scroll_distance or 420, context)))
        repeat = max(1, int(self._render_value(step.scroll_repeat or 1, context)))
        pause_ms = max(0, int(self._render_value(step.scroll_pause_ms or 0, context)))
        if (
            legacy_delta is not None
            and "scroll_distance" not in step.model_fields_set
            and "scroll_repeat" not in step.model_fields_set
        ):
            delta = int(self._render_value(legacy_delta, context))
            direction = "up" if delta < 0 else "down"
            distance = abs(delta)
            repeat = 1
            if "scroll_pause_ms" not in step.model_fields_set:
                pause_ms = 0
        delta = distance if direction != "up" else -distance
        before_y = await self._safe_scroll_y(context.page)
        wheel_events = 0
        repeat_segments: list[list[int]] = []
        reverse_events: list[int] = []
        reading_pause_count = 0
        for index in range(repeat):
            signed_segments = [
                segment if direction != "up" else -segment
                for segment in self._human_scroll_segments(distance)
            ]
            repeat_segments.append(signed_segments)
            for segment_index, segment_delta in enumerate(signed_segments):
                await context.page.mouse.wheel(0, segment_delta)
                wheel_events += 1
                await self._human_pause(*self.HUMAN_SCROLL_SEGMENT_PAUSE_RANGE)
                if segment_index < len(signed_segments) - 1 and random.random() < 0.18:
                    reading_pause_count += 1
                    await self._human_pause(*self.HUMAN_SCROLL_READING_PAUSE_RANGE)
            reverse_delta = await self._maybe_human_reverse_scroll(context.page, direction=direction, distance=distance)
            if reverse_delta:
                reverse_events.append(reverse_delta)
                wheel_events += 1
                reading_pause_count += 1
                await self._human_pause(*self.HUMAN_SCROLL_READING_PAUSE_RANGE)
            if pause_ms and index < repeat - 1:
                base_pause = pause_ms / 1000
                reading_pause_count += 1
                await self._human_pause(max(0.70, base_pause * 0.95), max(1.40, base_pause * 1.90))
        after_y = await self._safe_scroll_y(context.page)
        context.variables["last_scroll"] = {
            "direction": direction,
            "distance": distance,
            "repeat": repeat,
            "pause_ms": pause_ms,
            "delta_y": delta,
            "wheel_events": wheel_events,
            "segments": repeat_segments,
            "reverse_events": reverse_events,
            "reading_pause_count": reading_pause_count,
            "before_scroll_y": before_y,
            "after_scroll_y": after_y,
            "humanized": True,
        }

    async def _maybe_human_reverse_scroll(self, page: Any, *, direction: str, distance: int) -> int | None:
        if distance < 160 or random.random() > self.HUMAN_SCROLL_REVERSE_PROBABILITY:
            return None
        reverse_limit = max(20, min(distance // 3, self.HUMAN_SCROLL_REVERSE_DISTANCE_RANGE[1]))
        reverse_distance = random.randint(
            min(self.HUMAN_SCROLL_REVERSE_DISTANCE_RANGE[0], reverse_limit),
            reverse_limit,
        )
        reverse_delta = -reverse_distance if direction != "up" else reverse_distance
        await self._human_pause(0.25, 0.75)
        await page.mouse.wheel(0, reverse_delta)
        await self._human_pause(0.28, 0.85)
        return reverse_delta

    @staticmethod
    def _human_scroll_segments(distance: int) -> list[int]:
        normalized_distance = max(1, abs(distance))
        if normalized_distance <= 80:
            return [normalized_distance]
        target_step = random.randint(120, 220)
        segment_count = min(14, max(3, round(normalized_distance / target_step)))
        if segment_count <= 1:
            return [normalized_distance]
        weights = [random.uniform(0.72, 1.28) for _ in range(segment_count)]
        weight_total = sum(weights) or 1
        segments = [max(1, round(normalized_distance * weight / weight_total)) for weight in weights]
        segments[-1] += normalized_distance - sum(segments)
        if segments[-1] <= 0:
            borrow = 1 - segments[-1]
            segments[-1] = 1
            for index in range(len(segments) - 2, -1, -1):
                available = max(0, segments[index] - 1)
                take = min(available, borrow)
                segments[index] -= take
                borrow -= take
                if borrow == 0:
                    break
        return segments

    @staticmethod
    async def _safe_scroll_y(page: Any) -> int | None:
        try:
            return int(await page.evaluate("() => Math.round(window.scrollY || document.documentElement.scrollTop || 0)"))
        except Exception:  # noqa: BLE001
            return None

    async def _handle_sleep(self, step: WorkflowStep, context: ExecutionContext) -> None:
        duration = float(self._render_value(step.value or 1, context))
        await asyncio.sleep(duration)
        context.variables["last_sleep"] = {"seconds": duration}

    async def _handle_screenshot(self, step: WorkflowStep, context: ExecutionContext) -> None:
        output_dir = settings.artifact_dir / "screenshots" / "manual"
        output_dir.mkdir(parents=True, exist_ok=True)
        target = output_dir / f"{step.id}.png"
        await context.page.screenshot(path=str(target), full_page=True)
        if step.save_as:
            context.variables[step.save_as] = str(target)

    async def _handle_extract_text(self, step: WorkflowStep, context: ExecutionContext) -> None:
        timeout_ms = (step.timeout_sec or context.workflow.runtime_policy.step_timeout_sec) * 1000
        locator = await self._resolve_locator(step, context, timeout_ms=timeout_ms)
        text = await locator.text_content() or ""
        if step.save_as:
            context.variables[step.save_as] = text

    async def _handle_for_each(self, step: WorkflowStep, context: ExecutionContext) -> None:
        timeout_ms = (step.timeout_sec or context.workflow.runtime_policy.step_timeout_sec) * 1000
        locator = await self._resolve_locator(step, context, allow_many=True, timeout_ms=timeout_ms)
        count = await locator.count()
        for index in range(min(count, 10)):
            child_scope = locator.nth(index)
            previous_scope = context.current_scope
            context.current_scope = child_scope
            context.variables["loop_index"] = index
            for child_step in step.steps:
                if context.child_step_handler:
                    await context.child_step_handler(child_step, context)
                else:
                    await self._execute_step(context.task_run_id, child_step, context)
            context.current_scope = previous_scope

    @staticmethod
    def _is_random_many_click(step: WorkflowStep) -> bool:
        return step.type == "click" and step.click_target_mode == "random_many"

    @classmethod
    def _allows_many_matches(cls, step: WorkflowStep) -> bool:
        return step.type in {"for_each", "wait", "wait_visible"} or cls._is_random_many_click(step)

    @staticmethod
    def _random_indices(*, total: int, requested: int) -> list[int]:
        if total <= 0 or requested <= 0:
            return []
        limit = min(total, requested)
        return random.sample(range(total), limit)

    def _build_preview_workflow(
        self,
        *,
        step: WorkflowStep,
        locator: LocatorSpec | None,
    ) -> WorkflowDefinition:
        locator_key = step.selector_key or "preview_locator"
        step_payload = step.model_dump(mode="json")
        if locator:
            step_payload["selector_key"] = locator_key
        raw = {
            "metadata": {"name": "Preview Workflow", "version": "1.0.0"},
            "profile_policy": {
                "provider_type": settings.provider_default_type,
                "selection_mode": "explicit_profiles",
                "profile_ids": [],
            },
            "runtime_policy": {
                "mode": "visual",
                "page_timeout_sec": 30,
                "step_timeout_sec": step.timeout_sec or 15,
                "retry_once_on_failure": False,
                "screenshot_on_failure": False,
            },
            "steps": [step_payload],
            "locators": {locator_key: locator.model_dump(mode="json")} if locator else {},
        }
        return WorkflowDefinition.model_validate(raw)

    async def _resolve_locator_from_spec(
        self,
        *,
        locator_spec: LocatorSpec | None,
        fallback_selector: str | None,
        scope: Any,
        step_id: str,
        allow_many: bool,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        selectors = self._selectors_from_locator_spec(locator_spec, fallback_selector=fallback_selector)
        if not selectors:
            raise ExecutionError("missing_locator", f"Step '{step_id}' does not define a locator")

        deadline = asyncio.get_running_loop().time() + ((timeout_ms or 0) / 1000)
        ambiguous: list[tuple[str, int]] = []
        while True:
            ambiguous = []
            for selector in selectors:
                locator = scope.locator(selector)
                count = await locator.count()
                if count == 0:
                    continue
                if allow_many:
                    return {"locator": locator, "selector_used": selector, "match_count": count}
                if count == 1:
                    return {"locator": locator.first, "selector_used": selector, "match_count": count}
                equivalent = await self._try_resolve_equivalent_duplicate_locator(
                    locator=locator,
                    count=count,
                    selector=selector,
                    locator_spec=locator_spec,
                )
                if equivalent:
                    return equivalent
                ambiguous.append((selector, count))
            if not timeout_ms or asyncio.get_running_loop().time() >= deadline:
                break
            await asyncio.sleep(0.25)

        if ambiguous:
            selector, count = ambiguous[0]
            raise ExecutionError(
                "locator_ambiguous",
                f"Locator '{selector}' matched {count} elements in step '{step_id}', expected unique target",
            )
        raise ExecutionError("locator_missing", f"No locator matched any element for step '{step_id}'")

    async def _try_resolve_equivalent_duplicate_locator(
        self,
        *,
        locator: Any,
        count: int,
        selector: str,
        locator_spec: LocatorSpec | None,
    ) -> dict[str, Any] | None:
        if count <= 1:
            return None
        samples: list[dict[str, Any]] = []
        for index in range(min(count, 20)):
            target = locator.nth(index)
            signature = await self._element_duplicate_signature(target)
            if not signature:
                continue
            signature["index"] = index
            samples.append(signature)

        visible_samples = [
            sample
            for sample in samples
            if sample.get("visible") and not sample.get("disabled") and not sample.get("aria_hidden")
        ]
        if not visible_samples:
            return None

        chosen: dict[str, Any] | None = None
        reason: str | None = None
        if len(visible_samples) == 1:
            chosen = visible_samples[0]
            reason = "single_visible_duplicate"
        elif self._duplicate_samples_are_equivalent(visible_samples, locator_spec):
            chosen = visible_samples[0]
            reason = "equivalent_duplicate"

        if not chosen or reason is None:
            return None

        chosen_index = int(chosen.get("index") or 0)
        return {
            "locator": locator.nth(chosen_index),
            "selector_used": selector,
            "match_count": count,
            "disambiguation": {
                "strategy": reason,
                "chosen_index": chosen_index,
                "visible_count": len(visible_samples),
                "sampled_count": len(samples),
                "equivalence_key": self._duplicate_equivalence_key(chosen),
            },
        }

    async def _element_duplicate_signature(self, target: Any) -> dict[str, Any] | None:
        evaluate = getattr(target, "evaluate", None)
        if not callable(evaluate):
            return None
        try:
            return await evaluate(
                """(el) => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    const attrs = {};
                    const attrNames = [
                        "id",
                        "name",
                        "role",
                        "aria-label",
                        "aria-hidden",
                        "aria-disabled",
                        "data-testid",
                        "data-test",
                        "data-cy",
                        "data-qa",
                        "data-automation-id",
                        "data-et-name",
                        "data-et-element-type",
                        "data-et-prop-content_type",
                        "data-et-prop-location"
                    ];
                    for (const name of attrNames) {
                        const value = el.getAttribute(name);
                        if (value) attrs[name] = value;
                    }
                    const anchor = el.closest("a");
                    return {
                        tag: el.tagName.toLowerCase(),
                        text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160),
                        href: anchor ? (anchor.href || anchor.getAttribute("href") || "") : "",
                        attrs,
                        visible: style.display !== "none" &&
                            style.visibility !== "hidden" &&
                            Number(style.opacity || 1) > 0 &&
                            rect.width > 0 &&
                            rect.height > 0,
                        disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
                        aria_hidden: el.getAttribute("aria-hidden") === "true",
                        rect: {
                            x: Math.round(rect.x),
                            y: Math.round(rect.y),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height)
                        }
                    };
                }"""
            )
        except Exception:  # noqa: BLE001
            return None

    def _duplicate_samples_are_equivalent(
        self,
        samples: list[dict[str, Any]],
        locator_spec: LocatorSpec | None,
    ) -> bool:
        if len(samples) < 2:
            return False
        if not self._has_duplicate_disambiguation_anchor(samples, locator_spec):
            return False
        keys = {self._duplicate_equivalence_key(sample) for sample in samples}
        return len(keys) == 1 and "" not in keys

    def _has_duplicate_disambiguation_anchor(
        self,
        samples: list[dict[str, Any]],
        locator_spec: LocatorSpec | None,
    ) -> bool:
        expected_text = ""
        expected_attrs: dict[str, Any] = {}
        if locator_spec:
            expected_text = str(locator_spec.text_signature.get("normalized") or "").strip()
            expected_attrs = locator_spec.attribute_signature or {}
        first = samples[0]
        first_attrs = first.get("attrs") or {}
        business_keys = [
            "data-testid",
            "data-test",
            "data-cy",
            "data-qa",
            "data-automation-id",
            "data-et-name",
            "data-et-prop-content_type",
            "data-et-prop-location",
        ]
        has_text_anchor = bool(expected_text or first.get("text"))
        has_href_anchor = bool(first.get("href"))
        has_business_attr = any(expected_attrs.get(key) or first_attrs.get(key) for key in business_keys)
        return (has_text_anchor and has_href_anchor) or (has_text_anchor and has_business_attr)

    @staticmethod
    def _duplicate_equivalence_key(sample: dict[str, Any]) -> str:
        attrs = sample.get("attrs") or {}
        text = " ".join(str(sample.get("text") or "").split()).lower()
        href = str(sample.get("href") or "").split("#", 1)[0].strip()
        key_attrs = {
            key: attrs.get(key)
            for key in [
                "data-testid",
                "data-test",
                "data-cy",
                "data-qa",
                "data-automation-id",
                "data-et-name",
                "data-et-prop-content_type",
                "data-et-prop-location",
            ]
            if attrs.get(key)
        }
        if href:
            return f"text={text}|href={href}|attrs={sorted(key_attrs.items())}"
        if key_attrs:
            return f"text={text}|attrs={sorted(key_attrs.items())}"
        return ""

    async def _preview_locator_matches(
        self,
        *,
        locator_spec: LocatorSpec,
        scope: Any,
        allow_many: bool,
    ) -> dict[str, Any]:
        resolved = await self._resolve_locator_from_spec(
            locator_spec=locator_spec,
            fallback_selector=None,
            scope=scope,
            step_id="preview",
            allow_many=allow_many,
        )
        locator = resolved["locator"]
        match_count = resolved["match_count"]
        matched_texts: list[str] = []
        sample_size = min(match_count, 3)
        if allow_many:
            for index in range(sample_size):
                text = await locator.nth(index).text_content() or ""
                if text.strip():
                    matched_texts.append(text.strip()[:120])
        else:
            text = await locator.text_content() or ""
            if text.strip():
                matched_texts.append(text.strip()[:120])
        return {
            "selector_used": resolved["selector_used"],
            "match_count": match_count,
            "matched_texts": matched_texts,
        }

    def _latest_manual_preview_artifact(self, step_id: str) -> str | None:
        output_dir = settings.artifact_dir / "screenshots" / "manual"
        target = output_dir / f"{step_id}.png"
        return str(target) if target.exists() else None
