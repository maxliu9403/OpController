from __future__ import annotations

import asyncio
import random
from collections.abc import Callable
from collections import deque
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Deque


class FailureCategory(StrEnum):
    TRANSIENT_NETWORK = "transient_network"
    PROVIDER_OPEN_TRANSIENT = "provider_open_transient"
    BROWSER_ATTACH_TRANSIENT = "browser_attach_transient"
    PAGE_SLOW = "page_slow"
    LOCATOR_DRIFT = "locator_drift"
    CANCELLED = "cancelled"
    FATAL = "fatal"
    UNKNOWN = "unknown"


class RetryScope(StrEnum):
    PROFILE_OPEN = "profile_open"
    BROWSER_ATTACH = "browser_attach"
    NAVIGATION = "navigation"
    STEP = "step"


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int
    initial_delay_sec: float
    backoff_factor: float
    max_delay_sec: float
    jitter_ratio: float = 0.18

    def delay_for_failure(self, failure_count: int) -> float:
        if failure_count <= 0 or self.max_attempts <= 1:
            return 0.0
        base_delay = self.initial_delay_sec * (self.backoff_factor ** max(0, failure_count - 1))
        capped = min(base_delay, self.max_delay_sec)
        jitter = capped * self.jitter_ratio
        return max(0.0, capped + random.uniform(-jitter, jitter))


@dataclass(frozen=True)
class RetryDecision:
    retry: bool
    category: FailureCategory
    delay_sec: float = 0.0
    reason: str = ""


class FailureClassifier:
    TRANSIENT_NETWORK_PATTERNS = (
        "err_socks_connection_failed",
        "err_proxy_connection_failed",
        "err_timed_out",
        "err_connection_reset",
        "err_connection_closed",
        "err_connection_refused",
        "err_network_changed",
        "err_internet_disconnected",
        "socket disconnected",
        "network socket disconnected",
        "tls connection",
        "secure tls connection",
        "net::",
        "proxy",
        "socks",
    )
    PROVIDER_OPEN_CODES = {
        "profile_open_failed",
        "profile_open_timeout",
        "missing_debug_endpoint",
        "open_profile_missing_debug_endpoint",
    }
    BROWSER_ATTACH_CODES = {
        "browser_attach_timeout",
        "browser_attach_failed",
    }
    TRANSIENT_NETWORK_CODES = {
        "navigation_network_error",
    }
    LOCATOR_CODES = {
        "locator_missing",
        "locator_ambiguous",
        "locator_drift",
        "text_mismatch",
    }
    PAGE_SLOW_CODES = {
        "goto_timeout",
        "navigation_timeout",
        "wait_timeout",
        "page_load_timeout",
    }
    CANCELLED_CODES = {"batch_cancelled", "task_cancelled"}

    @classmethod
    def classify(cls, code: str | None = None, message: str | None = None, exc: BaseException | None = None) -> FailureCategory:
        normalized_code = cls._normalize(code or getattr(exc, "code", None))
        normalized_message = cls._normalize(message or getattr(exc, "message", None) or str(exc or ""))

        if normalized_code in cls.CANCELLED_CODES:
            return FailureCategory.CANCELLED
        if normalized_code in cls.TRANSIENT_NETWORK_CODES:
            return FailureCategory.TRANSIENT_NETWORK
        if normalized_code in cls.PROVIDER_OPEN_CODES:
            return FailureCategory.PROVIDER_OPEN_TRANSIENT
        if normalized_code in cls.BROWSER_ATTACH_CODES:
            return FailureCategory.BROWSER_ATTACH_TRANSIENT
        if normalized_code in cls.LOCATOR_CODES:
            return FailureCategory.LOCATOR_DRIFT
        if normalized_code in cls.PAGE_SLOW_CODES:
            return FailureCategory.PAGE_SLOW
        if any(pattern in normalized_message for pattern in cls.TRANSIENT_NETWORK_PATTERNS):
            return FailureCategory.TRANSIENT_NETWORK
        if "timeout" in normalized_message and any(word in normalized_message for word in ("page", "load", "navigation", "goto")):
            return FailureCategory.PAGE_SLOW
        if not normalized_message and not normalized_code:
            return FailureCategory.UNKNOWN
        return FailureCategory.FATAL

    @classmethod
    def is_retryable(cls, category: FailureCategory, scope: RetryScope) -> bool:
        if category in {
            FailureCategory.TRANSIENT_NETWORK,
            FailureCategory.PAGE_SLOW,
            FailureCategory.BROWSER_ATTACH_TRANSIENT,
        }:
            return scope in {RetryScope.BROWSER_ATTACH, RetryScope.NAVIGATION, RetryScope.STEP}
        if category == FailureCategory.PROVIDER_OPEN_TRANSIENT:
            return scope in {RetryScope.PROFILE_OPEN, RetryScope.BROWSER_ATTACH}
        return False

    @staticmethod
    def _normalize(value: Any) -> str:
        return str(value or "").strip().lower()


class RetryPlanner:
    def __init__(self, classifier: type[FailureClassifier] = FailureClassifier) -> None:
        self.classifier = classifier

    def decide(
        self,
        *,
        scope: RetryScope,
        attempt: int,
        policy: RetryPolicy,
        code: str | None = None,
        message: str | None = None,
        exc: BaseException | None = None,
    ) -> RetryDecision:
        category = self.classifier.classify(code=code, message=message, exc=exc)
        retry = attempt < policy.max_attempts and self.classifier.is_retryable(category, scope)
        delay = policy.delay_for_failure(attempt) if retry else 0.0
        return RetryDecision(
            retry=retry,
            category=category,
            delay_sec=delay,
            reason=f"{scope.value}:{category.value}:attempt_{attempt}_of_{policy.max_attempts}",
        )

    @staticmethod
    async def sleep(decision: RetryDecision) -> None:
        if decision.retry and decision.delay_sec > 0:
            await asyncio.sleep(decision.delay_sec)


class DynamicSlotController:
    def __init__(
        self,
        *,
        target_slots: int,
        initial_slots: int,
        min_slots: int,
        failure_rate_threshold: float,
        window_size: int,
        recovery_success_streak: int,
        poll_interval_sec: float,
        classifier: type[FailureClassifier] = FailureClassifier,
    ) -> None:
        self.target_slots = max(1, target_slots)
        self.current_slots = min(self.target_slots, max(1, initial_slots))
        self.min_slots = max(1, min(min_slots, self.target_slots))
        self.failure_rate_threshold = min(max(failure_rate_threshold, 0.0), 1.0)
        self.window_size = max(1, window_size)
        self.recovery_success_streak = max(1, recovery_success_streak)
        self.poll_interval_sec = max(0.05, poll_interval_sec)
        self.classifier = classifier
        self._recent_failures: Deque[bool] = deque(maxlen=self.window_size)
        self._success_streak = 0

    async def wait_for_slot(self, slot_index: int, cancelled: Callable[[], bool]) -> bool:
        while slot_index >= self.current_slots:
            if cancelled():
                return False
            await asyncio.sleep(self.poll_interval_sec)
        return True

    def record_success(self) -> dict[str, Any] | None:
        self._recent_failures.append(False)
        self._success_streak += 1
        if self.current_slots < self.target_slots and self._success_streak >= self.recovery_success_streak:
            self.current_slots += 1
            self._success_streak = 0
            return self.snapshot(reason="success_recovery")
        return None

    def record_failure(self, *, code: str | None, message: str | None) -> dict[str, Any] | None:
        category = self.classifier.classify(code=code, message=message)
        self._recent_failures.append(self._should_count_as_pressure(category))
        self._success_streak = 0
        if len(self._recent_failures) < min(3, self.window_size):
            return None
        failure_rate = sum(1 for item in self._recent_failures if item) / len(self._recent_failures)
        if failure_rate >= self.failure_rate_threshold and self.current_slots > self.min_slots:
            self.current_slots -= 1
            return self.snapshot(reason=f"failure_rate_{failure_rate:.2f}", category=category.value)
        return None

    def snapshot(self, **extra: Any) -> dict[str, Any]:
        recent_count = len(self._recent_failures)
        failure_rate = (sum(1 for item in self._recent_failures if item) / recent_count) if recent_count else 0.0
        return {
            "target_slots": self.target_slots,
            "current_slots": self.current_slots,
            "min_slots": self.min_slots,
            "recent_window": recent_count,
            "recent_failure_rate": round(failure_rate, 4),
            **extra,
        }

    @staticmethod
    def _should_count_as_pressure(category: FailureCategory) -> bool:
        return category in {
            FailureCategory.TRANSIENT_NETWORK,
            FailureCategory.PROVIDER_OPEN_TRANSIENT,
            FailureCategory.BROWSER_ATTACH_TRANSIENT,
            FailureCategory.PAGE_SLOW,
        }
