from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ProviderCapability(BaseModel):
    supports_profile_sync: bool = True
    supports_window_arrange: bool = True
    supports_group_tag_sync: bool = True
    supports_cookie_read: bool = False
    supports_cookie_write: bool = False
    supports_proxy_sync: bool = True
    supports_local_api_port_config: bool = True
    supports_native_opened_list: bool = True
    supports_download_dir_control: bool = False


class ProviderHealth(BaseModel):
    installed: bool
    healthy: bool
    message: str
    version: str | None = None
    api_base: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class ProviderInfo(BaseModel):
    provider_type: str
    display_name: str
    default_port: int | None = None
    capabilities: ProviderCapability
    health: ProviderHealth


class ProviderProfileRef(BaseModel):
    provider_type: str
    external_profile_id: str
    display_name: str
    group_summary: dict[str, Any] = Field(default_factory=dict)
    tag_summary: list[dict[str, Any]] = Field(default_factory=list)
    proxy_summary: dict[str, Any] = Field(default_factory=dict)
    provider_payload_json: dict[str, Any] = Field(default_factory=dict)


class ProviderGroupRef(BaseModel):
    provider_type: str
    external_group_id: str
    display_name: str
    profile_count: int | None = None
    provider_payload_json: dict[str, Any] = Field(default_factory=dict)


class ProviderScope(BaseModel):
    provider_type: str
    managed_group_ids: list[str] = Field(default_factory=list)
    include_profile_ids: list[str] = Field(default_factory=list)
    exclude_profile_ids: list[str] = Field(default_factory=list)
    is_configured: bool = False


class ProviderSessionRef(BaseModel):
    provider_type: str
    provider_profile_id: str
    provider_session_id: str | None = None
    browser_pid: int | None = None
    ws_endpoint: str | None = None
    debugging_address: str | None = None
    open_time: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProfileSyncResult(BaseModel):
    provider_type: str
    synced_count: int
    profiles: list[ProviderProfileRef]
