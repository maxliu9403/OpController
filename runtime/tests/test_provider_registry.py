from app.providers.registry import ProviderRegistry
from app.providers.bitbrowser import BitBrowserProvider
from app.providers.ixbrowser import IxBrowserProvider
from app.providers.nstbrowser import NstBrowserProvider


class DummyProvider:
    provider_type = "dummy"


def test_registry_round_trip() -> None:
    registry = ProviderRegistry()
    dummy = DummyProvider()
    registry.register(dummy)
    assert registry.get("dummy") is dummy


class MemoryConfigStore:
    async def get_values(self, provider_type: str) -> dict:
        return {}


def test_registry_supports_ixbrowser_nstbrowser_and_bitbrowser() -> None:
    registry = ProviderRegistry()
    registry.register(IxBrowserProvider())
    registry.register(NstBrowserProvider(config_store=MemoryConfigStore()))  # type: ignore[arg-type]
    registry.register(BitBrowserProvider(config_store=MemoryConfigStore()))  # type: ignore[arg-type]

    assert registry.get("ixbrowser").display_name == "ixBrowser"
    assert registry.get("nstbrowser").display_name == "NSTBrowser"
    assert registry.get("bitbrowser").display_name == "BitBrowser"
