"""FastAPI application and HTTP endpoints."""

import hmac
import json
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response, Security, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import APIKeyHeader

from .config import Settings
from .limits import RequestSizeLimitMiddleware
from .models import RunOut, RunStatus, StatsOut, TaskCreate, TaskOut, TaskPatch
from .repository import ConflictError, InputError, NotFoundError, Repository
from .scheduler import Scheduler
from .schedules import utc_now

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)
PROJECT_ROOT = Path(__file__).resolve().parents[2]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    repository = Repository(settings)
    scheduler = Scheduler(repository, settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        repository.initialize()
        if settings.scheduler_enabled:
            await scheduler.start()
        try:
            yield
        finally:
            if settings.scheduler_enabled:
                await scheduler.stop()

    app = FastAPI(
        title="Scheduled Task Manager API",
        description="Schedule HTTP and log tasks, inspect their outcomes, and retry failures.",
        version="1.0.0",
        lifespan=lifespan,
    )
    app.state.repository = repository
    app.state.scheduler = scheduler
    app.add_middleware(RequestSizeLimitMiddleware)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Content-Type", "X-API-Key"],
        )

    @app.exception_handler(NotFoundError)
    async def not_found_handler(request: Request, exc: NotFoundError):
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(ConflictError)
    async def conflict_handler(request: Request, exc: ConflictError):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    def validation_response(detail) -> Response:
        # Never echo the submitted payload (which may contain secrets), NaN, or
        # invalid Unicode from a malformed request into the error response.
        content = json.dumps({"detail": jsonable_encoder(detail)}, ensure_ascii=True, allow_nan=False)
        return Response(content=content, status_code=422, media_type="application/json")

    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(request: Request, exc: RequestValidationError):
        errors = [{key: error[key] for key in ("type", "loc", "msg")} for error in exc.errors()]
        return validation_response(errors)

    @app.exception_handler(InputError)
    async def input_handler(request: Request, exc: InputError):
        return validation_response(exc.detail)

    # Serve only the frontend's public files, never the repository or database.
    @app.get("/", include_in_schema=False)
    def root():
        return FileResponse(PROJECT_ROOT / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/app.js", include_in_schema=False)
    def frontend_script():
        return FileResponse(PROJECT_ROOT / "app.js", headers={"Cache-Control": "no-cache"})

    @app.get("/styles.css", include_in_schema=False)
    def frontend_styles():
        return FileResponse(PROJECT_ROOT / "styles.css", headers={"Cache-Control": "no-cache"})

    @app.get("/health", tags=["Operations"])
    def health():
        try:
            database_ok = repository.ping()
        except sqlite3.Error:
            database_ok = False
        worker = (
            "disabled" if not settings.scheduler_enabled else "running" if scheduler.running else "stopped"
        )
        healthy = database_ok and worker != "stopped"
        return JSONResponse(
            status_code=200 if healthy else 503,
            content={
                "status": "ok" if healthy else "unavailable",
                "database": "ok" if database_ok else "unavailable",
                "scheduler": worker,
            },
        )

    def require_api_key(key: Annotated[str | None, Security(api_key_header)]) -> None:
        if settings.api_key is not None:
            valid = key is not None and hmac.compare_digest(
                key.encode("utf-8"), settings.api_key.encode("utf-8")
            )
            if not valid:
                raise HTTPException(status_code=401, detail="Invalid or missing API key")

    router = APIRouter(prefix="/api/v1", dependencies=[Depends(require_api_key)])
    Limit = Annotated[int, Query(ge=1, le=100)]
    Offset = Annotated[int, Query(ge=0, le=2**63 - 1)]
    StatusFilter = Annotated[RunStatus | None, Query(alias="status")]

    @router.get("/stats", response_model=StatsOut, tags=["Operations"])
    def dashboard_stats():
        return repository.dashboard_stats(utc_now())

    @router.post("/tasks", response_model=TaskOut, status_code=status.HTTP_201_CREATED, tags=["Tasks"])
    def create_task(task: TaskCreate):
        return repository.create_task(task, utc_now())

    @router.get("/tasks", response_model=list[TaskOut], tags=["Tasks"])
    def list_tasks(limit: Limit = 50, offset: Offset = 0, enabled: bool | None = None):
        return repository.list_tasks(limit, offset, enabled)

    @router.get("/tasks/{task_id}", response_model=TaskOut, tags=["Tasks"])
    def get_task(task_id: str):
        return repository.get_task(task_id)

    @router.patch("/tasks/{task_id}", response_model=TaskOut, tags=["Tasks"])
    def update_task(task_id: str, patch: TaskPatch):
        return repository.update_task(task_id, patch, utc_now())

    @router.post("/tasks/{task_id}/pause", response_model=TaskOut, tags=["Tasks"])
    def pause_task(task_id: str):
        return repository.update_task(task_id, TaskPatch(enabled=False), utc_now())

    @router.post("/tasks/{task_id}/resume", response_model=TaskOut, tags=["Tasks"])
    def resume_task(task_id: str):
        return repository.update_task(task_id, TaskPatch(enabled=True), utc_now())

    @router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["Tasks"])
    def delete_task(task_id: str):
        repository.delete_task(task_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/tasks/{task_id}/runs", response_model=RunOut, status_code=status.HTTP_202_ACCEPTED, tags=["Runs"]
    )
    def trigger_task(task_id: str, response: Response):
        run = repository.trigger_task(task_id, utc_now())
        response.headers["Location"] = f"/api/v1/runs/{run['id']}"
        return run

    @router.get("/tasks/{task_id}/runs", response_model=list[RunOut], tags=["Runs"])
    def task_runs(task_id: str, limit: Limit = 50, offset: Offset = 0, run_status: StatusFilter = None):
        return repository.list_runs(limit, offset, task_id=task_id, status=run_status, require_task=True)

    @router.get("/runs", response_model=list[RunOut], tags=["Runs"])
    def list_runs(
        limit: Limit = 50, offset: Offset = 0, task_id: str | None = None, run_status: StatusFilter = None
    ):
        return repository.list_runs(limit, offset, task_id=task_id, status=run_status)

    @router.get("/runs/{run_id}", response_model=RunOut, tags=["Runs"])
    def get_run(run_id: str):
        return repository.get_run(run_id)

    app.include_router(router)
    return app


app = create_app()
