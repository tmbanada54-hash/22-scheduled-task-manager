FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATABASE_PATH=/data/tasks.sqlite3

# Keep the same layout as the repository: the application locates the shared
# frontend and canonical database schema relative to backend/app.
WORKDIR /app/backend
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --system --uid 10001 --no-create-home taskmanager \
    && mkdir -p /data \
    && chown taskmanager:taskmanager /data
COPY backend/app ./app
COPY database/schema.sqlite.sql database/seed.sqlite.sql /app/database/
COPY database/migrations/001_sqlite_backend_v1.sql database/migrations/002_sqlite_interval_log.sql /app/database/migrations/
COPY index.html app.js styles.css /app/

USER taskmanager
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
