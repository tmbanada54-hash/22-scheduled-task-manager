"""A small persistent scheduler running alongside the API."""

import asyncio
import logging
from collections.abc import Callable
from datetime import datetime

from .config import Settings
from .delivery import DeliveryClient, DeliveryResult
from .repository import Repository
from .schedules import utc_now

logger = logging.getLogger(__name__)


class Scheduler:
    def __init__(
        self,
        repository: Repository,
        settings: Settings,
        clock: Callable[[], datetime] = utc_now,
        delivery: DeliveryClient | None = None,
    ):
        self.repository = repository
        self.settings = settings
        self.clock = clock
        self.delivery = delivery or DeliveryClient(settings)
        self._loop_task: asyncio.Task | None = None
        self._inflight: set[asyncio.Task] = set()

    @property
    def running(self) -> bool:
        return self._loop_task is not None and not self._loop_task.done()

    async def start(self) -> None:
        await self.delivery.start()
        self._loop_task = asyncio.create_task(self._loop(), name="task-scheduler")

    async def stop(self) -> None:
        if self._loop_task is not None:
            self._loop_task.cancel()
            await asyncio.gather(self._loop_task, return_exceptions=True)
            self._loop_task = None
        # Graceful shutdown waits for bounded in-flight deliveries; a hard crash is
        # recovered via leases on the next startup.
        if self._inflight:
            await asyncio.gather(*list(self._inflight), return_exceptions=True)
        await self.delivery.close()

    async def _loop(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:
                logger.exception("Scheduler tick failed; it will be retried")
            await asyncio.sleep(self.settings.poll_interval_seconds)

    async def tick(self) -> None:
        now = self.clock()
        self.repository.recover_expired(now)
        self.repository.schedule_due(now)
        while len(self._inflight) < self.settings.max_concurrency:
            claim = self.repository.claim_next(self.clock())
            if claim is None:
                break
            task = asyncio.create_task(self._execute(claim), name=f"run-{claim['run_id']}")
            self._inflight.add(task)
            task.add_done_callback(self._inflight.discard)

    async def _execute(self, claim: dict) -> None:
        try:
            result = await self.delivery.send(claim)
        except Exception as exc:  # noqa: BLE001 - isolate failures from the worker loop
            # Do not log exception text: it may contain a URL or other secret.
            logger.error("Unexpected delivery error for run %s (%s)", claim["run_id"], type(exc).__name__)
            result = DeliveryResult(None, "Unexpected delivery error")
        try:
            self.repository.complete_attempt(
                claim["run_id"],
                claim["token"],
                self.clock(),
                result.http_status,
                result.error,
            )
        except Exception:
            # The lease will expire and be recovered if persistence is temporarily unavailable.
            logger.exception("Could not persist outcome for run %s", claim["run_id"])
