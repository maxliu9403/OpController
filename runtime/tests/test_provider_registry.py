from app.providers.registry import ProviderRegistry


class DummyProvider:
    provider_type = "dummy"


def test_registry_round_trip() -> None:
    registry = ProviderRegistry()
    dummy = DummyProvider()
    registry.register(dummy)
    assert registry.get("dummy") is dummy

