"""HTTP delivery with bounded timeouts and DNS-rebinding-resistant address checks."""

import asyncio
import json
import socket
from dataclasses import dataclass
from functools import partial

import aiohttp
from aiohttp.resolver import ThreadedResolver

from .config import Settings
from .security import TargetPolicy, is_public_address


class BlockedAddressError(OSError):
    pass


class PolicyResolver(ThreadedResolver):
    """Validate the actual DNS answers that aiohttp will connect to, not a preflight lookup."""

    def __init__(self, allow_private: bool):
        super().__init__()
        self.allow_private = allow_private

    async def resolve(self, host: str, port: int = 0, family: socket.AddressFamily = socket.AF_INET):
        addresses = await super().resolve(host, port, family)
        if not self.allow_private and any(not is_public_address(item["host"]) for item in addresses):
            raise BlockedAddressError("Target resolved to a non-public address")
        return addresses


@dataclass(frozen=True, slots=True)
class DeliveryResult:
    http_status: int | None
    error: str | None


class DeliveryClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.policy = TargetPolicy(settings)
        self.session: aiohttp.ClientSession | None = None

    async def start(self) -> None:
        resolver = PolicyResolver(self.settings.allow_private_targets)
        connector = aiohttp.TCPConnector(
            resolver=resolver,
            use_dns_cache=False,
            force_close=True,
            limit=self.settings.max_concurrency,
        )
        self.session = aiohttp.ClientSession(
            connector=connector,
            cookie_jar=aiohttp.DummyCookieJar(),
            trust_env=False,
            json_serialize=partial(json.dumps, ensure_ascii=False, allow_nan=False),
            headers={"User-Agent": "ScheduledTaskManager/1.0"},
        )

    async def close(self) -> None:
        if self.session is not None:
            await self.session.close()
            self.session = None

    async def send(self, claim: dict) -> DeliveryResult:
        if self.session is None:
            raise RuntimeError("Delivery client has not been started")
        snapshot = claim["snapshot"]
        try:
            # Check policy again at execution time, including literal IPs, which bypass DNS.
            self.policy.validate_url(snapshot["url"])
        except ValueError:
            return DeliveryResult(None, "Target is blocked by the outbound network policy")

        headers = dict(snapshot["headers"])
        headers.update(
            {
                "Idempotency-Key": claim["run_id"],
                "X-Scheduled-Task-Id": claim["task_id"],
                "X-Scheduled-Run-Id": claim["run_id"],
                "X-Scheduled-Attempt": str(claim["number"]),
            }
        )
        kwargs = {"headers": headers, "allow_redirects": False}
        if snapshot["body"] is not None:
            kwargs["json"] = snapshot["body"]
        try:
            # Enforce a total deadline, not just per-socket inactivity timeouts.
            async with asyncio.timeout(snapshot["timeout_seconds"]):
                async with self.session.request(snapshot["method"], snapshot["url"], **kwargs) as response:
                    status = response.status
                    # Do not download or persist potentially large or sensitive response bodies.
                    if 200 <= status < 300:
                        return DeliveryResult(status, None)
                    return DeliveryResult(status, f"HTTP {status}")
        except TimeoutError:
            return DeliveryResult(None, f"Request timed out after {snapshot['timeout_seconds']} seconds")
        except aiohttp.ClientConnectorError as exc:
            if isinstance(exc.os_error, BlockedAddressError):
                return DeliveryResult(None, "Target resolved to a non-public address")
            return DeliveryResult(None, "Could not connect to target")
        except aiohttp.ClientError:
            return DeliveryResult(None, "HTTP request failed")
