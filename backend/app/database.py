"""SQLite connection management and transactional schema upgrades."""

import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path

SCHEMA_VERSION = 2
DATABASE_DIR = Path(__file__).resolve().parents[2] / "database"
SCHEMA_PATH = DATABASE_DIR / "schema.sqlite.sql"
V1_TO_V2_PATH = DATABASE_DIR / "migrations" / "002_sqlite_interval_log.sql"


def _execute_script(conn: sqlite3.Connection, script: str) -> None:
    """Execute SQL statements without sqlite3.executescript's implicit commit."""
    statement = ""
    for line in script.splitlines(keepends=True):
        statement += line
        if sqlite3.complete_statement(statement):
            conn.execute(statement)
            statement = ""
    if statement.strip():
        raise RuntimeError("Incomplete SQLite schema statement")


class Database:
    def __init__(self, path: str):
        self.path = path

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        return conn

    def initialize(self) -> None:
        Path(self.path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        self.path = str(Path(self.path).expanduser())
        schema = SCHEMA_PATH.read_text(encoding="utf-8")
        with closing(self.connect()) as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            # Lock before checking the version so concurrent processes do not
            # both try to migrate the same database.
            conn.execute("PRAGMA foreign_keys = OFF")
            try:
                conn.execute("BEGIN IMMEDIATE")
                version = conn.execute("PRAGMA user_version").fetchone()[0]
                if version > SCHEMA_VERSION:
                    raise RuntimeError("Database schema is newer than this application")
                existing_tables = conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('tasks', 'runs', 'attempts')"
                ).fetchone()
                if version == 0 and existing_tables:
                    raise RuntimeError(
                        "Unversioned task tables found. Back them up and migrate the database team "
                        "prototype manually; it is not the application's SQLite schema."
                    )
                if version == 1:
                    _execute_script(conn, V1_TO_V2_PATH.read_text(encoding="utf-8"))
                _execute_script(conn, schema)
                if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
                    raise RuntimeError("SQLite migration failed its foreign-key check")
                conn.commit()
            except BaseException:
                conn.rollback()
                raise
            finally:
                conn.execute("PRAGMA foreign_keys = ON")

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            conn.execute("BEGIN")
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()
