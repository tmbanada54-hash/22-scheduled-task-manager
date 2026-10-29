import socket

import pytest
from aiohttp.resolver import ThreadedResolver

from app.config import Settings
from app.delivery import BlockedAddressError, PolicyResolver
from app.security import TargetPolicy, is_public_address


@pytest.mark.parametrize(
    "address,expected",
    [
        ("8.8.8.8", True),
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("172.16.0.1", False),
        ("169.254.169.254", False),
        ("100.64.0.1", False),
        ("224.0.0.1", False),
        ("::1", False),
        ("::ffff:127.0.0.1", False),
    ],
)
def test_public_ip_classification(address, expected):
    assert is_public_address(address) is expected


async def test_dns_answers_are_checked_and_the_checked_addresses_are_used(monkeypatch):
    async def fake_resolve(self, host, port=0, family=socket.AF_INET):
        return [
            {
                "hostname": host,
                "host": "8.8.8.8",
                "port": port,
                "family": socket.AF_INET,
                "proto": 0,
                "flags": 0,
            },
            {
                "hostname": host,
                "host": "127.0.0.1",
                "port": port,
                "family": socket.AF_INET,
                "proto": 0,
                "flags": 0,
            },
        ]

    monkeypatch.setattr(ThreadedResolver, "resolve", fake_resolve)
    resolver = PolicyResolver(allow_private=False)
    with pytest.raises(BlockedAddressError):
        await resolver.resolve("example.com", 80)
    permissive = PolicyResolver(allow_private=True)
    assert [item["host"] for item in await permissive.resolve("example.com", 80)] == ["8.8.8.8", "127.0.0.1"]
    await resolver.close()
    await permissive.close()


def test_exact_allowlist_and_private_opt_in():
    policy = TargetPolicy(Settings(allow_private_targets=True, allowed_target_hosts=("localhost",)))
    assert policy.validate_url("http://localhost:1234/hook") == "localhost"
    with pytest.raises(ValueError):
        policy.validate_url("http://127.0.0.1:1234/hook")
    with pytest.raises(ValueError):
        policy.validate_url("http://sub.localhost:1234/hook")


async def test_delivery_rejects_private_dns_before_connecting(monkeypatch):
    from app.delivery import DeliveryClient

    async def resolves_to_private(self, host, port=0, family=socket.AF_INET):
        return [
            {
                "hostname": host,
                "host": "127.0.0.1",
                "port": port,
                "family": socket.AF_INET,
                "proto": 0,
                "flags": socket.AI_NUMERICHOST,
            }
        ]

    monkeypatch.setattr(ThreadedResolver, "resolve", resolves_to_private)
    delivery = DeliveryClient(Settings())
    await delivery.start()
    try:
        result = await delivery.send(
            {
                "run_id": "run",
                "task_id": "task",
                "number": 1,
                "snapshot": {
                    "url": "http://public.example:43210/",
                    "method": "GET",
                    "headers": {},
                    "body": None,
                    "timeout_seconds": 1,
                },
            }
        )
        assert result.http_status is None
        assert result.error == "Target resolved to a non-public address"
    finally:
        await delivery.close()


def test_allowlist_uses_same_idna_normalization_as_http_client():
    policy = TargetPolicy(Settings(allowed_target_hosts=("fass.de",)))
    with pytest.raises(ValueError, match="ALLOWED_TARGET_HOSTS"):
        policy.validate_url("http://faß.de/")
    international = TargetPolicy(Settings(allowed_target_hosts=("faß.de",)))
    assert international.validate_url("http://faß.de/") == "xn--fa-hia.de"
