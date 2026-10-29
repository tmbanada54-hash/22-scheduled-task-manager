from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from app.models import TaskCreate, TaskPatch
from app.repository import ConflictError, Repository
from app.schedules import from_db


def create(repo, payload, now):
    return repo.create_task(TaskCreate.model_validate(payload), now)


def test_cron_coalesces_missed_ticks_and_prevents_overlap(repo, task_payload, now):
    task = create(repo, task_payload, now)
    assert from_db(task["next_run_at"]) == now + timedelta(minutes=5)
    assert repo.schedule_due(now + timedelta(minutes=17)) == 1
    runs = repo.list_runs(50, 0, task_id=task["id"])
    assert len(runs) == 1
    assert from_db(runs[0]["scheduled_for"]) == now + timedelta(minutes=5)
    assert from_db(repo.get_task(task["id"])["next_run_at"]) == now + timedelta(minutes=20)
    # An unfinished run causes recurring occurrences to be skipped, not queued.
    assert repo.schedule_due(now + timedelta(minutes=20)) == 0
    assert len(repo.list_runs(50, 0, task_id=task["id"])) == 1
    assert from_db(repo.get_task(task["id"])["next_run_at"]) == now + timedelta(minutes=25)


def test_once_waits_for_manual_run_and_is_not_rearmed_on_resume(repo, task_payload, now):
    scheduled = now + timedelta(seconds=10)
    task_payload["schedule"] = {"type": "once", "run_at": scheduled.isoformat()}
    task = create(repo, task_payload, now)
    manual = repo.trigger_task(task["id"], now)
    claim = repo.claim_next(now)
    assert claim["run_id"] == manual["id"]
    assert repo.schedule_due(scheduled) == 0
    assert from_db(repo.get_task(task["id"])["next_run_at"]) == scheduled
    assert repo.complete_attempt(manual["id"], claim["token"], scheduled + timedelta(seconds=1), 200, None)
    assert repo.schedule_due(scheduled + timedelta(seconds=1)) == 1
    scheduled_run = repo.list_runs(50, 0, task_id=task["id"])[0]
    assert scheduled_run["trigger"] == "scheduled"
    assert from_db(scheduled_run["scheduled_for"]) == scheduled
    assert repo.get_task(task["id"])["next_run_at"] is None
    repo.update_task(task["id"], TaskPatch(enabled=False), scheduled + timedelta(seconds=2))
    resumed = repo.update_task(task["id"], TaskPatch(enabled=True), scheduled + timedelta(seconds=3))
    assert resumed["next_run_at"] is None
    assert repo.schedule_due(scheduled + timedelta(seconds=4)) == 0


def test_paused_one_time_due_date_is_honored_on_resume(repo, task_payload, now):
    scheduled = now + timedelta(seconds=5)
    task_payload.update({"schedule": {"type": "once", "run_at": scheduled.isoformat()}, "enabled": False})
    task = create(repo, task_payload, now)
    assert task["next_run_at"] is None
    assert repo.schedule_due(scheduled + timedelta(seconds=1)) == 0
    resumed = repo.update_task(task["id"], TaskPatch(enabled=True), scheduled + timedelta(seconds=2))
    assert from_db(resumed["next_run_at"]) == scheduled
    assert repo.schedule_due(scheduled + timedelta(seconds=2)) == 1


def test_retry_exhaustion_persists_across_repository_restarts(repo, settings, task_payload, now):
    task = create(repo, task_payload, now)
    run = repo.trigger_task(task["id"], now)
    for index in range(3):
        attempt_time = now + timedelta(seconds=index * 2)
        claim = repo.claim_next(attempt_time)
        assert claim["number"] == index + 1
        assert repo.complete_attempt(run["id"], claim["token"], attempt_time, 503, "HTTP 503")
        expected = "retrying" if index < 2 else "failed"
        assert repo.get_run(run["id"])["status"] == expected
    restarted = Repository(settings)
    restarted.initialize()
    stored = restarted.get_run(run["id"])
    assert stored["status"] == "failed"
    assert stored["attempt_count"] == 3
    assert stored["finished_at"] is not None
    assert [attempt["http_status"] for attempt in stored["attempts"]] == [503, 503, 503]
    assert restarted.trigger_task(task["id"], now + timedelta(seconds=10))["status"] == "queued"


def test_worker_lease_recovery_snapshots_and_stale_completion(repo, task_payload, now):
    task = create(repo, task_payload, now)
    run = repo.trigger_task(task["id"], now)
    first = repo.claim_next(now)
    repo.update_task(
        task["id"],
        TaskPatch(url="https://example.com/new", retry={"max_retries": 0, "delay_seconds": 20}),
        now,
    )
    # timeout=2 and grace=2; an abandoned attempt is recorded as failed at expiry.
    assert repo.recover_expired(now + timedelta(seconds=3)) == 0
    assert repo.recover_expired(now + timedelta(seconds=4)) == 1
    assert not repo.complete_attempt(run["id"], first["token"], now + timedelta(seconds=4), 200, None)
    stored = repo.get_run(run["id"])
    assert stored["status"] == "retrying"
    assert stored["attempts"][0]["error"] == "Worker lease expired before the attempt finished"
    assert repo.claim_next(now + timedelta(seconds=4)) is None
    second = repo.claim_next(now + timedelta(seconds=5))
    assert second["snapshot"]["url"] == task_payload["url"]
    assert second["snapshot"]["max_retries"] == 2
    assert second["number"] == 2
    assert repo.complete_attempt(run["id"], second["token"], now + timedelta(seconds=5), 204, None)
    result = repo.get_run(run["id"])
    assert result["status"] == "succeeded"
    assert [attempt["status"] for attempt in result["attempts"]] == ["failed", "succeeded"]
    assert result["last_error"] is None


def test_pause_blocks_due_retries_until_resume(repo, task_payload, now):
    task = create(repo, task_payload, now)
    run = repo.trigger_task(task["id"], now)
    claim = repo.claim_next(now)
    repo.complete_attempt(run["id"], claim["token"], now, 503, "HTTP 503")
    repo.update_task(task["id"], TaskPatch(enabled=False), now)
    assert repo.claim_next(now + timedelta(seconds=10)) is None
    assert repo.get_run(run["id"])["status"] == "retrying"
    repo.update_task(task["id"], TaskPatch(enabled=True), now + timedelta(seconds=10))
    assert repo.claim_next(now + timedelta(seconds=10))["number"] == 2


def test_competing_requests_can_only_enqueue_one_active_run(repo, task_payload, now):
    task = create(repo, task_payload, now)

    def attempt(_):
        try:
            return repo.trigger_task(task["id"], now)["id"]
        except ConflictError:
            return None

    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(attempt, range(20)))
    assert len([result for result in results if result]) == 1
    assert len(repo.list_runs(50, 0, task_id=task["id"])) == 1


def test_competing_schedulers_create_and_claim_only_once(repo, settings, task_payload, now):
    task = create(repo, task_payload, now)
    other = Repository(settings)
    other.initialize()
    due = now + timedelta(minutes=5)
    with ThreadPoolExecutor(max_workers=2) as pool:
        scheduled = list(pool.map(lambda r: r.schedule_due(due), [repo, other]))
        claims = list(pool.map(lambda r: r.claim_next(due), [repo, other]))
    assert sum(scheduled) == 1
    assert sum(claim is not None for claim in claims) == 1
    assert len(repo.list_runs(50, 0, task_id=task["id"])) == 1
