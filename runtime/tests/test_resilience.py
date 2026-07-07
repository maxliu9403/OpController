from __future__ import annotations

import pytest

from app.config import settings
from app.services.batch_service import BatchService
from app.services.resilience import DynamicSlotController, FailureCategory, FailureClassifier, RetryPolicy, RetryScope


def test_classifier_marks_proxy_socket_errors_as_transient_network() -> None:
    category = FailureClassifier.classify(message="net::ERR_SOCKS_CONNECTION_FAILED at https://example.test")

    assert category == FailureCategory.TRANSIENT_NETWORK
    assert FailureClassifier.is_retryable(category, RetryScope.NAVIGATION) is True


def test_classifier_marks_locator_drift_as_non_retryable_for_navigation() -> None:
    category = FailureClassifier.classify(code="locator_ambiguous", message="matched 63 elements")

    assert category == FailureCategory.LOCATOR_DRIFT
    assert FailureClassifier.is_retryable(category, RetryScope.NAVIGATION) is False


def test_retry_policy_applies_bounded_backoff_with_jitter_disabled() -> None:
    policy = RetryPolicy(
        max_attempts=4,
        initial_delay_sec=2.0,
        backoff_factor=2.0,
        max_delay_sec=5.0,
        jitter_ratio=0.0,
    )

    assert policy.delay_for_failure(1) == 2.0
    assert policy.delay_for_failure(2) == 4.0
    assert policy.delay_for_failure(3) == 5.0


def test_dynamic_slot_controller_downshifts_and_recovers() -> None:
    controller = DynamicSlotController(
        target_slots=4,
        initial_slots=4,
        min_slots=1,
        failure_rate_threshold=0.5,
        window_size=4,
        recovery_success_streak=2,
        poll_interval_sec=0.01,
    )

    assert controller.current_slots == 4
    assert controller.record_failure(code="navigation_network_error", message="socket disconnected") is None
    assert controller.record_failure(code="browser_attach_timeout", message="attach timeout") is None
    snapshot = controller.record_failure(code="profile_open_timeout", message="open timeout")

    assert snapshot is not None
    assert snapshot["current_slots"] == 3
    assert snapshot["reason"].startswith("failure_rate_")

    assert controller.record_success() is None
    recovery_snapshot = controller.record_success()

    assert recovery_snapshot is not None
    assert recovery_snapshot["current_slots"] == 4
    assert recovery_snapshot["reason"] == "success_recovery"


def test_batch_slot_controller_starts_with_requested_slots_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "dynamic_slots_enabled", True)
    monkeypatch.setattr(settings, "dynamic_slots_warmup_enabled", False)
    monkeypatch.setattr(settings, "dynamic_slots_initial_limit", 2)

    controller = BatchService.__new__(BatchService)._build_slot_controller(6)

    assert controller.target_slots == 6
    assert controller.current_slots == 6


def test_batch_slot_controller_can_opt_into_warmup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "dynamic_slots_enabled", True)
    monkeypatch.setattr(settings, "dynamic_slots_warmup_enabled", True)
    monkeypatch.setattr(settings, "dynamic_slots_initial_limit", 2)

    controller = BatchService.__new__(BatchService)._build_slot_controller(6)

    assert controller.target_slots == 6
    assert controller.current_slots == 2


@pytest.mark.asyncio
async def test_dynamic_slot_wait_exits_when_cancelled(monkeypatch: pytest.MonkeyPatch) -> None:
    controller = DynamicSlotController(
        target_slots=4,
        initial_slots=1,
        min_slots=1,
        failure_rate_threshold=0.5,
        window_size=4,
        recovery_success_streak=2,
        poll_interval_sec=0.01,
    )
    calls = {"count": 0}

    async def no_sleep(delay: float) -> None:
        calls["count"] += 1

    monkeypatch.setattr("app.services.resilience.asyncio.sleep", no_sleep)

    allowed = await controller.wait_for_slot(3, lambda: calls["count"] >= 2)

    assert allowed is False
