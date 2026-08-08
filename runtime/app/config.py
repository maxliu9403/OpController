from __future__ import annotations

import os
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def resolve_runtime_version() -> str:
    if configured := os.getenv("OPCTRL_RUNTIME_VERSION"):
        return configured
    try:
        return package_version("opcontroller-runtime")
    except PackageNotFoundError:
        return "0.1.19"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="OPCTRL_", extra="ignore")

    app_name: str = "OpController Runtime"
    runtime_version: str = Field(default_factory=resolve_runtime_version)
    desktop_version: str | None = None
    host: str = "127.0.0.1"
    port: int = 18519
    api_token: str | None = None
    timezone: str = "Asia/Shanghai"
    base_dir: Path = Field(default_factory=lambda: Path.home() / ".opcontroller")
    data_dir_name: str = "data"
    db_file_name: str = "app.db"
    log_dir_name: str = "logs"
    artifact_dir_name: str = "artifacts"
    export_dir_name: str = "exports"
    cache_dir_name: str = "cache"
    schedule_input_dir_name: str = "schedule_inputs"
    provider_default_type: str = "ixbrowser"
    ixbrowser_api_base: str = "http://127.0.0.1:53200"
    ixbrowser_api_timeout_sec: float = 10.0
    nstbrowser_api_base: str = "http://localhost:8848/api/v2"
    nstbrowser_api_key: str | None = None
    nstbrowser_api_timeout_sec: float = 10.0
    bitbrowser_api_base: str = "http://127.0.0.1:54345"
    bitbrowser_api_timeout_sec: float = 10.0
    scheduler_poll_seconds: int = 5
    default_slot_limit: int = 6
    max_slot_limit: int = 10
    provider_health_timeout_sec: float = 5.0
    provider_health_cache_ttl_sec: float = 30.0
    provider_open_timeout_sec: float = 60.0
    provider_close_timeout_sec: float = 15.0
    browser_attach_timeout_sec: float = 25.0
    profile_open_retry_attempts: int = 3
    profile_open_retry_initial_delay_sec: float = 2.0
    profile_open_retry_backoff_factor: float = 1.8
    profile_open_retry_max_delay_sec: float = 12.0
    browser_attach_retry_attempts: int = 2
    browser_attach_retry_initial_delay_sec: float = 1.5
    browser_attach_retry_backoff_factor: float = 1.8
    browser_attach_retry_max_delay_sec: float = 8.0
    navigation_retry_attempts: int = 3
    navigation_retry_initial_delay_sec: float = 2.0
    navigation_retry_backoff_factor: float = 1.8
    navigation_retry_max_delay_sec: float = 12.0
    navigation_load_state_timeout_sec: float = 4.0
    navigation_networkidle_timeout_sec: float = 1.5
    navigation_stability_timeout_sec: float = 5.0
    navigation_stability_required_ms: int = 900
    dynamic_slots_enabled: bool = True
    dynamic_slots_warmup_enabled: bool = False
    dynamic_slots_initial_limit: int = 2
    dynamic_slots_min_limit: int = 1
    dynamic_slots_failure_rate_threshold: float = 0.3
    dynamic_slots_window_size: int = 8
    dynamic_slots_recovery_success_streak: int = 4
    dynamic_slots_poll_interval_sec: float = 0.5
    window_layout_timeout_sec: float = 6.0
    window_layout_screen_index: int = 0
    window_layout_margin_px: int = 10
    window_layout_top_offset_px: int = 30
    window_layout_bottom_reserved_px: int = 40
    window_layout_min_width: int = 320
    window_layout_min_height: int = 280
    window_layout_default_width: int = 500
    window_layout_default_height: int = 500
    window_layout_provider_deviation_px: int = 50
    random_click_max_count: int = 5
    # 0 means unlimited. Positive values are recorded as broad-match warnings only.
    random_click_max_match_count: int = 0
    failure_screenshot_full_page: bool = False
    manual_screenshot_full_page: bool = False
    monitor_queue_maxsize: int = 1000
    runtime_log_file_name: str = "runtime-app.log"

    @property
    def data_dir(self) -> Path:
        return self.base_dir / self.data_dir_name

    @property
    def db_path(self) -> Path:
        return self.data_dir / self.db_file_name

    @property
    def log_dir(self) -> Path:
        return self.base_dir / self.log_dir_name

    @property
    def artifact_dir(self) -> Path:
        return self.base_dir / self.artifact_dir_name

    @property
    def export_dir(self) -> Path:
        return self.base_dir / self.export_dir_name

    @property
    def cache_dir(self) -> Path:
        return self.base_dir / self.cache_dir_name

    @property
    def schedule_input_dir(self) -> Path:
        return self.data_dir / self.schedule_input_dir_name


settings = Settings()
