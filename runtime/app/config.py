from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="OPCTRL_", extra="ignore")

    app_name: str = "OpController Runtime"
    host: str = "127.0.0.1"
    port: int = 18519
    timezone: str = "Asia/Shanghai"
    base_dir: Path = Field(default_factory=lambda: Path.home() / ".opcontroller")
    data_dir_name: str = "data"
    db_file_name: str = "app.db"
    log_dir_name: str = "logs"
    artifact_dir_name: str = "artifacts"
    export_dir_name: str = "exports"
    cache_dir_name: str = "cache"
    provider_default_type: str = "ixbrowser"
    ixbrowser_api_base: str = "http://127.0.0.1:53200"
    ixbrowser_api_timeout_sec: float = 10.0
    scheduler_poll_seconds: int = 5
    default_slot_limit: int = 6
    max_slot_limit: int = 10
    provider_open_timeout_sec: float = 60.0
    provider_close_timeout_sec: float = 15.0
    browser_attach_timeout_sec: float = 25.0
    window_layout_timeout_sec: float = 6.0

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


settings = Settings()
