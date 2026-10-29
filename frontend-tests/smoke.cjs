/* Real-browser integration test. Starts isolated API/worker/receiver processes. */
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const backend = path.join(root, 'backend');
const python = process.env.PYTHON_BIN || 'python3';
const key = 'browser-integration-test-key';
const headers = { 'X-API-Key': key };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, server) {
  for (let i = 0; i < 160; i += 1) {
    if (server.exitCode !== null) throw new Error(`Server exited with code ${server.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch { /* Wait for Uvicorn to bind. */ }
    await sleep(100);
  }
  throw new Error('Timed out waiting for the test server');
}

async function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  process.kill('SIGTERM');
  await Promise.race([once(process, 'exit'), sleep(3000)]);
  if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
}

async function main() {
  const apiPort = await unusedPort();
  const receiverPort = await unusedPort();
  const base = `http://127.0.0.1:${apiPort}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tickwise-browser-test-'));
  const childEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
  const receiver = spawn(python, ['examples/webhook_receiver.py', '--port', String(receiverPort)], {
    cwd: backend, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(apiPort)], {
    cwd: backend, env: {
      ...childEnv,
      DATABASE_PATH: path.join(temp, 'tasks.sqlite3'), API_KEY: key,
      ALLOW_PRIVATE_TARGETS: 'true', ALLOWED_TARGET_HOSTS: '127.0.0.1',
      SCHEDULER_ENABLED: 'true', POLL_INTERVAL_SECONDS: '0.05',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  for (const child of [receiver, server]) {
    child.stdout.on('data', (data) => { logs = (logs + data.toString()).slice(-12000); });
    child.stderr.on('data', (data) => { logs = (logs + data.toString()).slice(-12000); });
    child.on('error', (error) => { logs += `\nProcess error: ${error.message}`; });
  }
  let browser;
  try {
    await waitForHealth(base, server);
    browser = await chromium.launch({
      ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
      headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#view-landing')).toHaveClass(/is-active/);

    // An unauthenticated dashboard redirects to genuine shared-key access.
    await page.locator('a[href="#/dashboard"]').first().click();
    await expect(page.locator('#view-auth')).toHaveClass(/is-active/);
    await page.locator('#authKey').fill('wrong-key');
    await page.locator('#authSubmit').click();
    await expect(page.locator('[data-error-for="authKey"]')).toContainText('valid workspace API key');
    await page.locator('#authKey').fill(key);
    await page.locator('#authSubmit').click();
    await expect(page.locator('#view-dashboard')).toHaveClass(/is-active/);
    await expect(page.locator('#statTotal')).toHaveText('0');

    // The form creates a real persisted log task. Literal HTML must not execute.
    const logMessage = '<img src=x onerror="window.injected=true"> Real log';
    await page.locator('#taskName').fill('Browser log task');
    await page.locator('#taskInterval').fill('3600');
    await page.locator('#taskPayload').fill(logMessage);
    await page.locator('#createBtn').click();
    let logCard = page.locator('.task-card').filter({ hasText: 'Browser log task' });
    await expect(logCard).toBeVisible();
    const logId = await logCard.getAttribute('data-task-id');
    await expect(page.locator('#statTotal')).toHaveText('1');
    await page.reload();
    await expect(page.locator('#view-dashboard')).toHaveClass(/is-active/);
    logCard = page.locator(`.task-card[data-task-id="${logId}"]`);
    await expect(logCard).toBeVisible();
    await expect(logCard.locator('.task-payload')).toHaveText(logMessage);
    expect(await page.evaluate(() => window.injected)).toBeUndefined();

    // Pause, resume, queue a manual run, and view the stored attempt/output.
    await logCard.locator('[data-op="toggle"]').click();
    await expect(logCard.locator('[data-op="toggle"]')).toHaveText('Resume');
    await expect(logCard.locator('[data-op="run"]')).toBeDisabled();
    await logCard.locator('[data-op="toggle"]').click();
    await expect(logCard.locator('[data-op="toggle"]')).toHaveText('Pause');
    await logCard.locator('[data-op="run"]').click();
    await expect.poll(async () => {
      const response = await page.request.get(`${base}/api/v1/tasks/${logId}/runs`, { headers });
      const runs = await response.json();
      return runs[0]?.status;
    }, { timeout: 12000 }).toBe('succeeded');
    await logCard.locator('[data-op="history"]').click();
    await expect(page.locator('#historyBody')).toContainText('Success');
    await expect(page.locator('#historyBody')).toContainText(logMessage);
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    await page.locator('[data-action="close-history"]').last().click();

    // Page through real persisted histories, not a capped in-browser sample.
    for (let i = 0; i < 50; i += 1) {
      const queued = await page.request.post(`${base}/api/v1/tasks/${logId}/runs`, { headers });
      expect(queued.status()).toBe(202);
      const runId = (await queued.json()).id;
      await expect.poll(async () => {
        return (await (await page.request.get(`${base}/api/v1/runs/${runId}`, { headers })).json()).status;
      }, { timeout: 12000, intervals: [25, 50, 100] }).toBe('succeeded');
    }
    await logCard.locator('[data-op="history"]').click();
    await expect(page.locator('#historyPagination')).toBeVisible();
    await expect(page.locator('#historyPageLabel')).toHaveText('Runs 1–50');
    await page.locator('#historyNext').click();
    await expect(page.locator('#historyPageLabel')).toHaveText('Runs 51–51');
    await expect(page.locator('#historyNext')).toBeDisabled();
    await page.locator('#historyPrev').click();
    await expect(page.locator('#historyPageLabel')).toHaveText('Runs 1–50');
    await page.locator('[data-action="close-history"]').last().click();

    // Real HTTP delivery to an isolated local receiver; no external service needed.
    await page.locator('#taskName').fill('Browser HTTP task');
    await page.locator('#taskInterval').fill('3600');
    await page.locator('#taskRetries').fill('0');
    await page.locator('#taskAction').selectOption('http');
    await page.locator('#taskPayload').fill(`http://127.0.0.1:${receiverPort}/ok`);
    await page.locator('#createBtn').click();
    const httpCard = page.locator('.task-card').filter({ hasText: 'Browser HTTP task' });
    await expect(httpCard).toBeVisible();
    const httpId = await httpCard.getAttribute('data-task-id');
    await httpCard.locator('[data-op="run"]').click();
    await expect.poll(async () => {
      const runs = await (await page.request.get(`${base}/api/v1/tasks/${httpId}/runs`, { headers })).json();
      return runs[0]?.status;
    }, { timeout: 12000 }).toBe('succeeded');
    await httpCard.locator('[data-op="history"]').click();
    await expect(page.locator('#historyBody')).toContainText('HTTP 200');
    await page.locator('[data-action="close-history"]').last().click();

    // Failed HTTP attempts are reported honestly and may be deleted from the UI.
    await page.locator('#taskName').fill('Failing HTTP task');
    await page.locator('#taskInterval').fill('3600');
    await page.locator('#taskRetries').fill('0');
    await page.locator('#taskAction').selectOption('http');
    await page.locator('#taskPayload').fill(`http://127.0.0.1:${receiverPort}/fail`);
    await page.locator('#createBtn').click();
    const failedCard = page.locator('.task-card').filter({ hasText: 'Failing HTTP task' });
    await expect(failedCard).toBeVisible();
    const failedId = await failedCard.getAttribute('data-task-id');
    await failedCard.locator('[data-op="run"]').click();
    await expect.poll(async () => {
      const runs = await (await page.request.get(`${base}/api/v1/tasks/${failedId}/runs`, { headers })).json();
      return runs[0]?.status;
    }, { timeout: 12000 }).toBe('failed');
    await failedCard.locator('[data-op="history"]').click();
    await expect(page.locator('#historyBody')).toContainText('HTTP 503');
    await expect(page.locator('#historyBody')).toContainText('failed');
    await page.locator('[data-action="close-history"]').last().click();
    page.once('dialog', (dialog) => dialog.accept());
    await failedCard.locator('[data-op="delete"]').click();
    await expect(failedCard).toHaveCount(0);

    // Cron and one-time tasks created through the API are displayed accurately.
    const extraIds = [];
    for (const [name, schedule] of [
      ['Cron task', { type: 'cron', expression: '*/5 * * * *' }],
      ['One-time task', { type: 'once', run_at: new Date(Date.now() + 3600000).toISOString() }],
    ]) {
      const response = await page.request.post(`${base}/api/v1/tasks`, {
        headers, data: { name, action_type: 'log', message: 'from API', schedule },
      });
      expect(response.status()).toBe(201);
      extraIds.push((await response.json()).id);
    }
    await page.reload();
    await expect(page.locator('.task-card').filter({ hasText: 'Cron task' })).toContainText('Cron */5 * * * * (UTC)');
    await expect(page.locator('.task-card').filter({ hasText: 'One-time task' })).toContainText('One-time');
    for (const id of extraIds) {
      expect((await page.request.delete(`${base}/api/v1/tasks/${id}`, { headers })).status()).toBe(204);
    }

    // Make enough tasks to exercise both pages; search intentionally filters a page.
    for (let i = 0; i < 101; i += 1) {
      const response = await page.request.post(`${base}/api/v1/tasks`, {
        headers,
        data: { name: `Page task ${String(i).padStart(3, '0')}`, action_type: 'log', message: 'sample',
          schedule: { type: 'interval', seconds: 3600 } },
      });
      expect(response.status()).toBe(201);
    }
    await page.reload();
    await expect(page.locator('#statTotal')).toHaveText('103');
    await expect(page.locator('#taskPagination')).toBeVisible();
    await expect(page.locator('#pageLabel')).toHaveText('Page 1');
    await page.locator('#nextPage').click();
    await expect(page.locator('#pageLabel')).toHaveText('Page 2');
    await expect(page.locator('#prevPage')).toBeEnabled();
    await page.locator('#prevPage').click();
    await expect(page.locator('#pageLabel')).toHaveText('Page 1');

    // Delete invokes the server, not a local mock. Clearing the key removes access.
    const firstCard = page.locator('.task-card').filter({ hasText: 'Page task 100' });
    await expect(firstCard).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await firstCard.locator('[data-op="delete"]').click();
    await expect(firstCard).toHaveCount(0);
    await expect(page.locator('#statTotal')).toHaveText('102');
    await page.locator('#logoutBtn').click();
    await expect(page.locator('#view-auth')).toHaveClass(/is-active/);
    expect(await page.evaluate(() => sessionStorage.getItem('tickwise.api-key.v1'))).toBeNull();
    expect(pageErrors).toEqual([]);
    console.log('Browser smoke test passed: key access, persistence, pause/resume, log and HTTP success/failure, cron/once display, task/history pagination, delete, XSS checks.');
  } catch (error) {
    console.error(`\nChild-process logs:\n${logs}`);
    throw error;
  } finally {
    if (browser) await browser.close();
    await Promise.all([stop(server), stop(receiver)]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
