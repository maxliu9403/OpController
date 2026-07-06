from __future__ import annotations

from typing import Callable

import pytest

from app.schemas.workflow import LocatorSpec, WorkflowDefinition, WorkflowStep
from app.services.execution_service import ExecutionContext, ExecutionError, ExecutionService


class FakeElement:
    def __init__(self, index: int, clicked: list[int], on_click: Callable[[int], None] | None = None) -> None:
        self.index = index
        self.clicked = clicked
        self.on_click = on_click

    async def click(self, *, timeout: int) -> None:
        self.clicked.append(self.index)
        if self.on_click:
            self.on_click(self.index)


class FakeLocator:
    def __init__(self, count: int, clicked: list[int], on_click: Callable[[int], None] | None = None) -> None:
        self._count = count
        self.clicked = clicked
        self.on_click = on_click

    async def count(self) -> int:
        return self._count

    def nth(self, index: int) -> FakeElement:
        return FakeElement(index, self.clicked, self.on_click)

    @property
    def first(self) -> FakeElement:
        return self.nth(0)


class FakeMouse:
    def __init__(self) -> None:
        self.wheels: list[tuple[int, int]] = []

    async def wheel(self, delta_x: int, delta_y: int) -> None:
        self.wheels.append((delta_x, delta_y))


class FakePage:
    def __init__(self, locator: FakeLocator) -> None:
        self._locator = locator
        self.url = "https://example.test"
        self.mouse = FakeMouse()

    def locator(self, selector: str) -> FakeLocator:
        return self._locator

    async def title(self) -> str:
        return "Example"

    async def evaluate(self, script: str):
        return 0


class NavigatingFakePage(FakePage):
    def __init__(self) -> None:
        clicked: list[int] = []

        def navigate(index: int) -> None:
            self.url = f"https://example.test/listing/{index}"

        super().__init__(FakeLocator(count=1, clicked=clicked, on_click=navigate))
        self.url = "https://example.test/search"
        self.load_states: list[str] = []

    async def wait_for_load_state(self, state: str, *, timeout: int) -> None:
        self.load_states.append(state)


class SelectorMapScope:
    def __init__(self, counts_by_selector: dict[str, int]) -> None:
        self.counts_by_selector = counts_by_selector
        self.clicked: list[int] = []
        self.seen_selectors: list[str] = []

    def locator(self, selector: str) -> FakeLocator:
        self.seen_selectors.append(selector)
        return FakeLocator(count=self.counts_by_selector.get(selector, 0), clicked=self.clicked)


class DuplicateElement:
    def __init__(self, index: int, signature: dict[str, object]) -> None:
        self.index = index
        self.signature = signature

    async def evaluate(self, script: str) -> dict[str, object]:
        return self.signature


class DuplicateLocator:
    def __init__(self, signatures: list[dict[str, object]]) -> None:
        self.signatures = signatures

    async def count(self) -> int:
        return len(self.signatures)

    def nth(self, index: int) -> DuplicateElement:
        return DuplicateElement(index, self.signatures[index])

    @property
    def first(self) -> DuplicateElement:
        return self.nth(0)


class DuplicateScope:
    def __init__(self, selector: str, signatures: list[dict[str, object]]) -> None:
        self.selector = selector
        self.signatures = signatures

    def locator(self, selector: str) -> DuplicateLocator:
        return DuplicateLocator(self.signatures if selector == self.selector else [])


@pytest.fixture(autouse=True)
def no_human_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_sleep(duration: float) -> None:
        return None

    monkeypatch.setattr("app.services.execution_service.asyncio.sleep", no_sleep)


def make_workflow(step: WorkflowStep) -> WorkflowDefinition:
    return WorkflowDefinition.model_validate(
        {
            "metadata": {"name": "Test", "version": "1.0.0"},
            "profile_policy": {
                "provider_type": "ixbrowser",
                "selection_mode": "explicit_profiles",
                "profile_ids": ["101"],
            },
            "runtime_policy": {"mode": "visual", "step_timeout_sec": 15},
            "steps": [step.model_dump(mode="json")],
            "locators": {"target": {"primary_selector": "svg", "stability_score": 0.5}},
        }
    )


@pytest.mark.asyncio
async def test_click_random_many_allows_ambiguous_locator(monkeypatch: pytest.MonkeyPatch) -> None:
    clicked: list[int] = []
    locator = FakeLocator(count=5, clicked=clicked)
    step = WorkflowStep(
        id="preview",
        type="click",
        selector_key="target",
        click_target_mode="random_many",
        random_click_count=3,
    )
    workflow = make_workflow(step)
    context = ExecutionContext(
        page=FakePage(locator),
        browser=None,
        workflow=workflow,
        task_run_id="preview",
        row_payload={},
    )
    monkeypatch.setattr("app.services.execution_service.random.sample", lambda population, k: [2, 4, 0])

    await ExecutionService(session_factory=None, monitor=None)._handle_click(step, context)

    assert clicked == [2, 4, 0]
    assert context.variables["last_random_click"]["matched_count"] == 5
    assert context.variables["last_random_click"]["clicked_count"] == 3


@pytest.mark.asyncio
async def test_click_unique_still_rejects_ambiguous_locator() -> None:
    clicked: list[int] = []
    locator = FakeLocator(count=5, clicked=clicked)
    step = WorkflowStep(id="preview", type="click", selector_key="target")
    workflow = make_workflow(step)
    context = ExecutionContext(
        page=FakePage(locator),
        browser=None,
        workflow=workflow,
        task_run_id="preview",
        row_payload={},
    )

    with pytest.raises(ExecutionError, match="matched 5 elements"):
        await ExecutionService(session_factory=None, monitor=None)._handle_click(step, context)

    assert clicked == []


@pytest.mark.asyncio
async def test_click_waits_for_same_tab_navigation(monkeypatch: pytest.MonkeyPatch) -> None:
    page = NavigatingFakePage()
    step = WorkflowStep(id="open-detail", type="click", selector_key="target")
    workflow = make_workflow(step)
    context = ExecutionContext(
        page=page,
        browser=None,
        workflow=workflow,
        task_run_id="preview",
        row_payload={},
    )
    service = ExecutionService(session_factory=None, monitor=None)

    async def stable_probe(*args, **kwargs):
        return True

    monkeypatch.setattr(service, "_wait_page_stable_probe", stable_probe)

    await service._handle_click(step, context)

    assert context.variables["last_click"]["navigation_detected"] is True
    assert context.variables["last_click"]["url_before"] == "https://example.test/search"
    assert context.variables["last_click"]["url_after"] == "https://example.test/listing/0"
    assert context.variables["last_click"]["navigation_checkpoints"]["page_stable"] is True
    assert page.load_states == ["domcontentloaded", "load", "networkidle"]


@pytest.mark.asyncio
async def test_click_random_many_stops_after_navigation(monkeypatch: pytest.MonkeyPatch) -> None:
    clicked: list[int] = []
    page = FakePage(FakeLocator(count=5, clicked=clicked))
    page.url = "https://example.test/search"

    def navigate(index: int) -> None:
        page.url = f"https://example.test/listing/{index}"

    locator = FakeLocator(count=5, clicked=clicked, on_click=navigate)
    page._locator = locator
    step = WorkflowStep(
        id="open-random-detail",
        type="click",
        selector_key="target",
        click_target_mode="random_many",
        random_click_count=3,
    )
    workflow = make_workflow(step)
    context = ExecutionContext(
        page=page,
        browser=None,
        workflow=workflow,
        task_run_id="preview",
        row_payload={},
    )
    service = ExecutionService(session_factory=None, monitor=None)
    monkeypatch.setattr("app.services.execution_service.random.sample", lambda population, k: [2, 4, 0])

    async def wait_for_load_state(state: str, *, timeout: int) -> None:
        return None

    async def stable_probe(*args, **kwargs):
        return True

    page.wait_for_load_state = wait_for_load_state
    monkeypatch.setattr(service, "_wait_page_stable_probe", stable_probe)

    await service._handle_click(step, context)

    assert clicked == [2]
    assert context.variables["last_random_click"]["clicked_count"] == 1
    assert context.variables["last_random_click"]["clicked_indices"] == [2]
    assert context.variables["last_random_click"]["stopped_after_navigation"] is True


@pytest.mark.asyncio
async def test_resolve_locator_builds_semantic_selector_from_saved_signature() -> None:
    locator_spec = LocatorSpec(
        primary_selector='[data-et-element-type="button"]',
        fallback_selectors=[
            '[data-et-name="seller"]',
            '[data-et-prop-content_type="closet"]',
        ],
        tag_name="a",
        text_signature={"normalized": "View Closet"},
        attribute_signature={
            "data-et-name": "seller",
            "data-et-element-type": "button",
            "data-et-prop-content_type": "closet",
            "data-et-prop-location": "closet_widget",
        },
        stability_score=0.97,
    )
    scope = SelectorMapScope(
        {
            'a[data-et-name="seller"][data-et-prop-content_type="closet"]:has-text("View Closet")': 1,
            '[data-et-element-type="button"]': 63,
            '[data-et-name="seller"]': 3,
            '[data-et-prop-content_type="closet"]': 2,
        }
    )

    result = await ExecutionService(session_factory=None, monitor=None)._resolve_locator_from_spec(
        locator_spec=locator_spec,
        fallback_selector=None,
        scope=scope,
        step_id="click-13",
        allow_many=False,
    )

    assert result["selector_used"] == (
        'a[data-et-name="seller"][data-et-prop-content_type="closet"]:has-text("View Closet")'
    )
    assert result["match_count"] == 1
    assert scope.seen_selectors[0] == result["selector_used"]


@pytest.mark.asyncio
async def test_resolve_locator_accepts_equivalent_duplicate_targets() -> None:
    selector = 'a[data-et-name="seller"][data-et-prop-content_type="closet"]:has-text("View Closet")'
    locator_spec = LocatorSpec(
        primary_selector=selector,
        tag_name="a",
        text_signature={"normalized": "View Closet"},
        attribute_signature={
            "data-et-name": "seller",
            "data-et-prop-content_type": "closet",
            "data-et-prop-location": "closet_widget",
        },
        stability_score=0.97,
    )
    scope = DuplicateScope(
        selector,
        [
            {
                "tag": "a",
                "text": "View Closet",
                "href": "https://poshmark.com/closet/gods_love444",
                "attrs": {
                    "data-et-name": "seller",
                    "data-et-prop-content_type": "closet",
                    "data-et-prop-location": "closet_widget",
                },
                "visible": True,
                "disabled": False,
                "aria_hidden": False,
            },
            {
                "tag": "a",
                "text": "View Closet",
                "href": "https://poshmark.com/closet/gods_love444",
                "attrs": {
                    "data-et-name": "seller",
                    "data-et-prop-content_type": "closet",
                    "data-et-prop-location": "closet_widget",
                },
                "visible": True,
                "disabled": False,
                "aria_hidden": False,
            },
        ],
    )

    result = await ExecutionService(session_factory=None, monitor=None)._resolve_locator_from_spec(
        locator_spec=locator_spec,
        fallback_selector=None,
        scope=scope,
        step_id="click-13",
        allow_many=False,
    )

    assert result["locator"].index == 0
    assert result["match_count"] == 2
    assert result["disambiguation"]["strategy"] == "equivalent_duplicate"


@pytest.mark.asyncio
async def test_resolve_locator_rejects_non_equivalent_duplicate_targets() -> None:
    selector = 'a[data-et-name="seller"][data-et-prop-content_type="closet"]:has-text("View Closet")'
    locator_spec = LocatorSpec(
        primary_selector=selector,
        tag_name="a",
        text_signature={"normalized": "View Closet"},
        attribute_signature={
            "data-et-name": "seller",
            "data-et-prop-content_type": "closet",
        },
        stability_score=0.97,
    )
    scope = DuplicateScope(
        selector,
        [
            {
                "tag": "a",
                "text": "View Closet",
                "href": "https://poshmark.com/closet/seller_one",
                "attrs": {
                    "data-et-name": "seller",
                    "data-et-prop-content_type": "closet",
                },
                "visible": True,
                "disabled": False,
                "aria_hidden": False,
            },
            {
                "tag": "a",
                "text": "View Closet",
                "href": "https://poshmark.com/closet/seller_two",
                "attrs": {
                    "data-et-name": "seller",
                    "data-et-prop-content_type": "closet",
                },
                "visible": True,
                "disabled": False,
                "aria_hidden": False,
            },
        ],
    )

    with pytest.raises(ExecutionError, match="matched 2 elements"):
        await ExecutionService(session_factory=None, monitor=None)._resolve_locator_from_spec(
            locator_spec=locator_spec,
            fallback_selector=None,
            scope=scope,
            step_id="click-13",
            allow_many=False,
        )


@pytest.mark.asyncio
async def test_click_random_many_skips_when_locator_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    step = WorkflowStep(
        id="preview",
        type="click",
        selector_key="target",
        click_target_mode="random_many",
        random_click_count=3,
    )
    workflow = make_workflow(step)
    context = ExecutionContext(
        page=FakePage(FakeLocator(count=0, clicked=[])),
        browser=None,
        workflow=workflow,
        task_run_id="preview",
        row_payload={},
    )
    service = ExecutionService(session_factory=None, monitor=None)

    async def missing_locator(*args, **kwargs):
        raise ExecutionError("locator_missing", "No locator matched any element")

    monkeypatch.setattr(service, "_resolve_locator", missing_locator)

    await service._handle_click(step, context)

    assert context.variables["last_random_click"]["skipped"] is True
    assert context.variables["last_random_click"]["clicked_count"] == 0


@pytest.mark.asyncio
async def test_wait_element_count_succeeds_when_minimum_is_reached() -> None:
    locator = FakeLocator(count=3, clicked=[])
    step = WorkflowStep(
        id="wait-feed",
        type="wait",
        selector_key="target",
        wait_mode="element_count",
        min_count=2,
        timeout_sec=1,
    )
    workflow = make_workflow(step)
    context = ExecutionContext(
        page=FakePage(locator),
        browser=None,
        workflow=workflow,
        task_run_id="preview",
        row_payload={},
    )

    await ExecutionService(session_factory=None, monitor=None)._handle_wait(step, context)

    assert context.variables["last_wait"]["success"] is True
    assert context.variables["last_wait"]["matched_count"] == 3
    assert context.variables["last_wait"]["min_count"] == 2


@pytest.mark.asyncio
async def test_wait_timeout_can_continue_with_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    step = WorkflowStep(
        id="wait-optional-feed",
        type="wait",
        selector_key="target",
        wait_mode="element_count",
        min_count=1,
        timeout_sec=1,
        on_timeout="continue_with_warning",
    )
    workflow = make_workflow(step)
    context = ExecutionContext(
        page=FakePage(FakeLocator(count=0, clicked=[])),
        browser=None,
        workflow=workflow,
        task_run_id="preview",
        row_payload={},
    )
    service = ExecutionService(session_factory=None, monitor=None)

    async def timeout_wait(*args, **kwargs):
        raise ExecutionError("wait_timeout", "feed did not become ready")

    monkeypatch.setattr(service, "_wait_element_count", timeout_wait)

    await service._handle_wait(step, context)

    assert context.variables["last_wait"]["success"] is False
    assert context.variables["last_wait"]["error_code"] == "wait_timeout"
    assert context.variables["wait_warnings"][0]["step_id"] == "wait-optional-feed"


@pytest.mark.asyncio
async def test_generic_page_wait_locator_is_upgraded_to_page_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    step = WorkflowStep(
        id="wait-page",
        type="wait",
        label="等待页面就绪",
        selector_key="page_wait",
        wait_mode="element_visible",
        timeout_sec=10,
    )
    workflow = WorkflowDefinition.model_validate(
        {
            "metadata": {"name": "Test", "version": "1.0.0"},
            "profile_policy": {
                "provider_type": "ixbrowser",
                "selection_mode": "explicit_profiles",
                "profile_ids": ["101"],
            },
            "runtime_policy": {"mode": "visual", "step_timeout_sec": 15},
            "steps": [step.model_dump(mode="json")],
            "locators": {
                "page_wait": {
                    "primary_selector": 'div:has-text("等待页面出现")',
                    "fallback_selectors": ['text="等待页面出现"', "div"],
                    "tag_name": "div",
                    "text_signature": {"normalized": "等待页面出现"},
                    "stability_score": 0.38,
                }
            },
        }
    )
    context = ExecutionContext(
        page=FakePage(FakeLocator(count=1, clicked=[])),
        browser=None,
        workflow=workflow,
        task_run_id="preview",
        row_payload={},
    )
    service = ExecutionService(session_factory=None, monitor=None)

    async def page_ready(*args, **kwargs):
        return {"checkpoints": {"load": True}, "stable_ms": 2500}

    async def element_visible(*args, **kwargs):
        raise AssertionError("generic page wait should not use element_visible")

    monkeypatch.setattr(service, "_wait_page_ready", page_ready)
    monkeypatch.setattr(service, "_wait_element_visible", element_visible)

    await service._handle_wait(step, context)

    assert context.variables["last_wait"]["mode"] == "page_ready"
    assert context.variables["last_wait"]["success"] is True


@pytest.mark.asyncio
async def test_preview_workflow_executes_all_steps(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ExecutionService(session_factory=None, monitor=None)

    async def attach_browser(endpoint: str):
        return None, FakePage(FakeLocator(count=0, clicked=[])), None

    async def no_sleep(duration: float) -> None:
        return None

    monkeypatch.setattr(service, "_attach_browser", attach_browser)
    monkeypatch.setattr("app.services.execution_service.asyncio.sleep", no_sleep)
    workflow_payload = {
        "metadata": {"name": "Dry Run", "version": "1.0.0"},
        "profile_policy": {
            "provider_type": "ixbrowser",
            "selection_mode": "explicit_profiles",
            "profile_ids": ["101"],
        },
        "runtime_policy": {"mode": "visual", "step_timeout_sec": 15},
        "steps": [
            {"id": "sleep-1", "type": "sleep", "label": "停留等待", "value": 1},
            {"id": "sleep-2", "type": "sleep", "label": "再次等待", "value": 2},
        ],
        "locators": {},
    }

    result = await service.preview_workflow(
        endpoint="ws://example",
        workflow_payload=workflow_payload,
        row_payload={"keyword": "demo"},
    )

    assert result.success is True
    assert result.total_steps == 2
    assert result.succeeded_steps == 2
    assert [step.step_id for step in result.steps] == ["sleep-1", "sleep-2"]
    assert result.steps[0].outputs["seconds"] == 1


@pytest.mark.asyncio
async def test_scroll_step_repeats_wheel_with_direction(monkeypatch: pytest.MonkeyPatch) -> None:
    page = FakePage(FakeLocator(count=0, clicked=[]))
    step = WorkflowStep(
        id="scroll-1",
        type="scroll",
        label="滚动页面",
        scroll_direction="up",
        scroll_distance=500,
        scroll_repeat=3,
        scroll_pause_ms=100,
    )
    workflow = make_workflow(step)
    context = ExecutionContext(
        page=page,
        browser=None,
        workflow=workflow,
        task_run_id="preview",
        row_payload={},
    )

    service = ExecutionService(session_factory=None, monitor=None)
    monkeypatch.setattr(service, "_human_scroll_segments", lambda distance: [120, 180, 200])

    async def no_reverse(*args, **kwargs):
        return None

    monkeypatch.setattr(service, "_maybe_human_reverse_scroll", no_reverse)

    await service._handle_scroll(step, context)

    assert page.mouse.wheels == [(0, -120), (0, -180), (0, -200)] * 3
    assert context.variables["last_scroll"]["direction"] == "up"
    assert context.variables["last_scroll"]["repeat"] == 3
    assert context.variables["last_scroll"]["wheel_events"] == 9
    assert context.variables["last_scroll"]["reverse_events"] == []
    assert context.variables["last_scroll"]["humanized"] is True


@pytest.mark.asyncio
async def test_scroll_step_can_add_reverse_reading_motion(monkeypatch: pytest.MonkeyPatch) -> None:
    page = FakePage(FakeLocator(count=0, clicked=[]))
    step = WorkflowStep(
        id="scroll-1",
        type="scroll",
        label="滚动页面",
        scroll_direction="down",
        scroll_distance=360,
        scroll_repeat=1,
        scroll_pause_ms=1200,
    )
    workflow = make_workflow(step)
    context = ExecutionContext(
        page=page,
        browser=None,
        workflow=workflow,
        task_run_id="preview",
        row_payload={},
    )
    service = ExecutionService(session_factory=None, monitor=None)
    monkeypatch.setattr(service, "_human_scroll_segments", lambda distance: [120, 120, 120])
    monkeypatch.setattr("app.services.execution_service.random.random", lambda: 0.99)

    async def reverse(page, *, direction: str, distance: int):
        await page.mouse.wheel(0, -80)
        return -80

    monkeypatch.setattr(service, "_maybe_human_reverse_scroll", reverse)

    await service._handle_scroll(step, context)

    assert page.mouse.wheels == [(0, 120), (0, 120), (0, 120), (0, -80)]
    assert context.variables["last_scroll"]["wheel_events"] == 4
    assert context.variables["last_scroll"]["reverse_events"] == [-80]
    assert context.variables["last_scroll"]["reading_pause_count"] == 1
