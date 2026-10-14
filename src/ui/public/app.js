/* global document, window, history, fetch, Node */
const state = { csrf: null, operator: null, view: 'board', advanced: 'overview', data: null, console: null, inspectRef: null, decisionRef: null, decisionGroup: 'all', decisionSearch: '', decisionError: null, answerDraft: {} };
const app = document.querySelector('#app');
const sessionStatus = document.querySelector('#session-status');
const toast = document.querySelector('#toast');
let renderGeneration = 0;

const json = (value) => JSON.stringify(value, null, 2);
const outcomeLabel = {
  completed: 'Completed', refused: 'Refused', 'awaiting-approval': 'Awaiting approval',
  'ready-to-dispatch': 'Authorized, ready to dispatch', 'quota-waiting': 'Waiting on subscription allowance',
  'attempts-exhausted': 'Attempt limit reached', 'unsupported-settings': 'Unsupported model/effort settings',
  'setup-blocked': 'Setup incomplete', 'remote-uncertain': 'Remote state uncertain',
  'native-unavailable': 'Native runner unavailable', 'checks-failed': 'No confirmed success', running: 'Running',
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child instanceof Node) node.append(child);
    else if (child !== null && child !== undefined) node.append(document.createTextNode(String(child)));
  }
  return node;
}

function showToast(message, error = false) {
  toast.textContent = message;
  toast.className = `toast${error ? ' error' : ''}`;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 5000);
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (state.csrf && options.method && options.method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const payload = await response.json().catch(() => ({ ok: false, error: { message: `HTTP ${response.status}` } }));
  if (response.status === 401) {
    // Name the real cause: a bootstrap link that was already used or belongs to another server is not an expired session.
    const code = payload.error?.code;
    throw new Error(code === 'bootstrap-used' ? 'This link was already used. Restart the UI server for a new one, or open the page without the #bootstrap part if this browser already has a session.'
      : code === 'bootstrap-invalid' ? 'This link is not from the running UI server. Use the URL it printed most recently.'
        : 'The UI session expired. Start a new local UI server and use its printed URL.');
  }
  if (!response.ok && !payload.outcome && !payload.stdout) {
    const error = new Error(payload.error?.message || `Request failed (${response.status}).`);
    error.code = payload.error?.code;
    throw error;
  }
  return payload;
}

async function apiText(path) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'text/plain' } });
  if (response.status === 401) throw new Error('The UI session expired. Start a new local UI server and use its printed URL.');
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
  return response.text();
}

async function bootstrap() {
  const match = /(?:^|#)bootstrap=([^&]+)/.exec(window.location.hash);
  if (match) {
    const payload = await api('/api/session/bootstrap', { method: 'POST', headers: { 'X-UI-Bootstrap': decodeURIComponent(match[1]) } });
    state.csrf = payload.csrfToken;
    state.operator = payload.operator;
    history.replaceState(null, '', window.location.pathname);
  } else {
    const payload = await api('/api/session');
    state.csrf = payload.csrfToken;
    state.operator = payload.operator;
  }
  sessionStatus.textContent = state.operator ? `Operator: ${state.operator}` : 'No operator configured; read-only setup required';
  // Without a target store there is no board; the coordinator's own views are what there is.
  try {
    await api('/api/console/steer');
  } catch (error) {
    if (error.code === 'console-not-configured') state.view = 'advanced';
  }
  await renderView();
}

function panel(title, children = [], extra = {}) {
  return el('section', { class: 'panel', ...(extra.id ? { id: extra.id } : {}) }, [el('h2', { text: title }), ...children]);
}
function card(title, value, detail = '') {
  return el('article', { class: 'card' }, [el('h3', { text: title }), el('div', { class: 'metric', text: value }), detail ? el('p', { class: 'muted small', text: detail }) : null]);
}
function statusBadge(value) {
  const kind = value === 'completed' || value === 'ready' ? 'ok' : ['refused', 'checks-failed', 'setup-blocked'].includes(value) ? 'bad' : 'warn';
  return el('span', { class: `status ${kind}`, text: outcomeLabel[value] || value });
}
function outputBlock(payload) {
  const output = payload.stdout || payload.stderr || payload.error?.message || payload.outcome?.summary || json(payload);
  return el('pre', { class: 'output', text: output });
}
function empty(message) { return el('p', { class: 'muted', text: message }); }

function operationLabel(operation) {
  const kind = operation.result?.outcome?.kind;
  if (kind) return outcomeLabel[kind] || kind;
  if (operation.state === 'running') return 'Running';
  if (operation.state === 'failed') return 'Operation failed';
  return 'Completed';
}

function showOperation(slot, initial) {
  const update = async () => {
    let operation = initial;
    if (operation.state === 'running') operation = await api(`/api/operations/${encodeURIComponent(operation.id)}`);
    const outcome = operation.result?.outcome;
    const attempted = typeof operation.result?.runtimeDispatched === 'boolean'
      ? `Adapter invoked: ${operation.result.runtimeDispatched ? 'yes' : 'no'}`
      : null;
    slot.replaceChildren(
      el('p', {}, [el('strong', { text: operationLabel(operation) }), ` · ${operation.id}`]),
      attempted ? el('p', { class: 'muted', text: attempted }) : null,
      outcome ? el('p', { class: 'muted', text: outcome.summary || outcome.nextAction || '' }) : null,
      operation.error ? el('p', { class: 'muted', text: operation.error }) : null,
      el('pre', { class: 'output', text: json(operation.result ?? operation) }),
    );
    if (operation.state === 'running') window.setTimeout(update, 50);
  };
  void update();
}

async function renderOverview(current) {
  const data = await api('/api/overview');
  if (!current()) return;
  state.data = data;
  const runs = data.status.runs;
  const active = runs.filter((entry) => entry.active).length;
  const grants = data.authority.grants.filter((grant) => grant.status === 'active').length;
  const checks = data.evidence.requiredChecks;
  app.replaceChildren(
    panel('Coordinator state', [
      el('div', { class: 'grid' }, [
        card('Active runs', active, 'No progress percentage is inferred.'),
        card('Jobs', data.jobs.jobs.length, 'Jobs and obligations survive restart.'),
        card('Active grants', grants, grants === 0 ? 'Approval-only operation.' : 'Operator-issued standing authority.'),
        card('Runtime readiness', 'On demand', 'Open Safety to run the live readiness check.'),
        card('Required checks', checks.length, checks.length ? 'Deferred checks remain untested.' : 'No acceptance checks are configured.'),
        card('Paid allowance remaining', `$${Number(data.ledger.remainingUsd).toFixed(4)}`, 'Unknown actuals retain their bounds.'),
      ]),
      el('div', { class: 'actions' }, [el('button', { class: 'secondary', text: 'Refresh', onclick: renderView })]),
    ]),
    panel('Runs', [runs.length ? runTable(runs) : empty('No runs recorded.')]),
    panel('Runtime readiness', [empty('Live runtime checks are not run on page load. Open Safety to refresh them explicitly.')]),
    panel('Admission', [empty('Live subscription usage is not read on page load. Open Safety to refresh it explicitly.')]),
  );
}

function runTable(runs) {
  const table = el('table', {}, [el('thead', {}, [el('tr', {}, ['Run', 'Task', 'Runtime', 'Status', 'Authority', 'Observed settings'].map((value) => el('th', { text: value })))]), el('tbody')]);
  const body = table.querySelector('tbody');
  for (const entry of runs) {
    const run = entry.run;
    body.append(el('tr', {}, [
      el('td', { text: run.id }), el('td', { text: run.taskId }), el('td', { text: run.runtime }),
      el('td', {}, [statusBadge(run.status)]),
      el('td', { text: `${run.authority.type}:${run.authority.id}@v${run.authority.version}` }),
      el('td', { text: `${run.settings.observed.model}/${run.settings.observed.effort}` }),
    ]));
  }
  return table;
}

function readinessTable(readiness) {
  const table = el('table', {}, [el('thead', {}, [el('tr', {}, ['Runtime', 'State', 'Next action'].map((value) => el('th', { text: value })))]), el('tbody')]);
  const body = table.querySelector('tbody');
  for (const runtime of readiness) body.append(el('tr', {}, [el('td', { text: runtime.runtime }), el('td', {}, [runtime.ready ? statusBadge('ready') : statusBadge(runtime.outcome?.kind || 'setup-blocked')]), el('td', { text: runtime.outcome?.nextAction || 'Ready.' })]));
  return table;
}

function usageSummary(usage) {
  const list = el('ul', { class: 'list' });
  for (const runtime of usage.runtimes) {
    const result = runtime.result;
    list.append(el('li', {}, [el('strong', { text: `${runtime.runtime} (${runtime.subscriptionId})` }), result.ok ? el('p', { class: 'small muted', text: result.reading.windows.map((window) => `${window.kind}: ${window.usedPercent}% used`).join(' · ') }) : el('p', { class: 'small', text: `UNAVAILABLE: ${result.unavailable.reason}. Next: ${result.unavailable.operatorAction}` })]));
  }
  return el('div', {}, [el('div', { class: 'actions' }, [el('button', { class: 'secondary', text: 'Refresh usage', onclick: async () => { state.view = 'advanced'; state.advanced = 'safety'; await renderView(); } })]), list]);
}

async function renderWork(current) {
  const [status, jobs] = await Promise.all([api('/api/status'), api('/api/jobs')]);
  if (!current()) return;
  const operationOutput = el('div', { id: 'operation-status' });
  const form = dispatchForm(operationOutput);
  const recover = el('button', { class: 'secondary', text: 'Recover unsettled work', onclick: async () => {
    try {
      const result = await api('/api/recover', { method: 'POST', body: JSON.stringify({}) });
      showOperation(operationOutput, result);
    } catch (error) { showToast(error.message, true); }
  } });
  app.replaceChildren(
    panel('Work queue', [el('div', { class: 'actions' }, [recover]), status.runs.length ? runTable(status.runs) : empty('No runs recorded.')]),
    panel('Jobs', [jobs.jobs.length ? jobTable(jobs.jobs) : empty('No jobs recorded.'), intakeForm()]),
    panel('Dispatch an approved task', [el('p', { class: 'muted small', text: 'This form requires an existing individual approval. Grant-triggered work must retain its event job and source.' }), form]),
    panel('Operation status', [operationOutput]),
  );
}

function jobTable(jobs) {
  const table = el('table', {}, [el('thead', {}, [el('tr', {}, ['Job', 'Task', 'Repository', 'State', 'Obligations'].map((value) => el('th', { text: value })))]), el('tbody')]);
  const body = table.querySelector('tbody');
  for (const job of jobs) body.append(el('tr', {}, [el('td', { text: job.id }), el('td', { text: job.taskId }), el('td', { text: job.repo }), el('td', { text: job.state }), el('td', { text: job.outstandingObligations.join(', ') || 'none' })]));
  return table;
}

function intakeForm() {
  return commandForm('Record CI failure', [
    ['source', 'Event source'], ['repo', 'Repository'], ['workflowName', 'Workflow name'], ['runId', 'CI run ID'],
    ['headSha', 'Head SHA'], ['branch', 'Branch'], ['conclusion', 'Conclusion'], ['title', 'Failure title'],
    ['summary', 'Failure summary'], ['workClass', 'Work class'], ['runtime', 'Runtime'], ['profile', 'Profile'],
    ['actions', 'Actions (comma-separated)'], ['obligations', 'Obligations (comma-separated)'],
  ], async (values) => {
    const split = (value) => value.split(',').map((entry) => entry.trim()).filter(Boolean);
    return api('/api/intake', { method: 'POST', body: JSON.stringify({
      event: {
        source: values.source, repo: values.repo, workflowName: values.workflowName, runId: values.runId,
        headSha: values.headSha, branch: values.branch, conclusion: values.conclusion, title: values.title,
        ...(values.summary ? { summary: values.summary } : {}),
      },
      workClass: values.workClass, runtime: values.runtime, profile: values.profile,
      actions: split(values.actions), obligations: split(values.obligations),
    }) });
  });
}

function dispatchForm(operationOutput) {
  const fields = {};
  const field = (name, label, type = 'text', extra = {}) => { const input = el(type === 'textarea' ? 'textarea' : 'input', { name, ...(type !== 'textarea' ? { type } : {}), ...extra }); fields[name] = input; return el('label', { text: label }, [input]); };
  const actions = ['author-changes', 'open-pr', 'review', 'run-verification', 'deploy-dev'].map((value) => { const input = el('input', { type: 'checkbox', value }); return el('label', { class: 'small' }, [input, value]); });
  const form = el('form', {}, [
    el('div', { class: 'form-grid' }, [field('taskId', 'Task ID'), field('repo', 'Repository'), field('workClass', 'Work class'), field('runtime', 'Runtime'), field('profile', 'Profile'), field('approvalId', 'Approval ID'), field('jobId', 'Existing job ID (optional)'), field('triggerSource', 'Trigger source (optional)'), field('repoPath', 'Trusted repository path')]),
    field('prompt', 'Prompt', 'textarea'),
    el('fieldset', {}, [el('legend', { text: 'Actions' }), el('div', { class: 'actions' }, actions)]),
    el('div', { class: 'form-grid' }, [field('model', 'Model (optional)'), field('effort', 'Effort (optional)'), field('prBase', 'PR base (optional)'), field('targetProject', 'Target project (optional)')]),
    el('div', { class: 'form-grid' }, [field('fiveHourPercent', 'Estimate: five-hour %', 'number', { min: '0', step: '0.1' }), field('weeklyPercent', 'Estimate: weekly %', 'number', { min: '0', step: '0.1' }), field('uncertaintyPercent', 'Uncertainty %', 'number', { min: '0', step: '0.1' }), field('estimateDetail', 'Estimate basis detail')]),
    field('estimateBasis', 'Estimate basis'),
    el('label', { class: 'small' }, [el('input', { type: 'checkbox', name: 'acceptVendorDefault' }), 'Accept vendor defaults (Codex cloud only)']),
    el('button', { class: 'primary', type: 'submit', text: 'Dispatch' }),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const checked = [...form.querySelectorAll('input[type=checkbox][value]:checked')].map((input) => input.value);
    const payload = {
      taskId: fields.taskId.value, repo: fields.repo.value, workClass: fields.workClass.value, runtime: fields.runtime.value, profile: fields.profile.value,
      approvalId: fields.approvalId.value || undefined, jobId: fields.jobId.value || undefined, triggerSource: fields.triggerSource.value || undefined, repoPath: fields.repoPath.value || undefined, prompt: fields.prompt.value,
      actions: checked, model: fields.model.value || undefined, effort: fields.effort.value || undefined,
      prBase: fields.prBase.value || undefined, targetProject: fields.targetProject.value || undefined,
      settings: { model: fields.model.value || undefined, effort: fields.effort.value || undefined, acceptVendorDefault: form.querySelector('input[name=acceptVendorDefault]').checked },
      estimate: { fiveHourPercent: Number(fields.fiveHourPercent.value), weeklyPercent: Number(fields.weeklyPercent.value), uncertaintyPercent: Number(fields.uncertaintyPercent.value), basis: fields.estimateBasis.value, detail: fields.estimateDetail.value },
    };
    try { const result = await api('/api/dispatch', { method: 'POST', body: JSON.stringify(payload) }); showOperation(operationOutput, result); } catch (error) { showToast(error.message, true); }
  });
  return form;
}

async function renderAuthority(current) {
  const data = await api('/api/authority');
  if (!current()) return;
  app.replaceChildren(
    panel('Approvals', [approvalForm(), data.approvals.length ? authorityList(data.approvals) : empty('No approvals recorded.')]),
    panel('Standing grants', [grantForm(), data.grants.length ? authorityList(data.grants) : empty('No grants recorded. The initial state is approval-only.'), grantLifecycleForm(data.grants)]),
  );
}

function authorityList(records) {
  const list = el('ul', { class: 'list' });
  for (const record of records) list.append(el('li', {}, [el('strong', { text: `${record.id} · ${record.status || 'approval'}` }), el('pre', { class: 'output', text: json(record) })]));
  return list;
}

function grantLifecycleForm(grants) {
  const active = grants.filter((grant) => grant.status === 'active');
  if (!active.length) return empty('No active grant to narrow or revoke.');
  const form = el('form', {}, [el('label', { text: 'Active grant' }, [el('select', { name: 'id' }, active.map((grant) => el('option', { value: grant.id, text: grant.id })))]), el('label', { text: 'Reason' }, [el('input', { name: 'reason' })]), el('div', { class: 'actions' }, [el('button', { class: 'secondary', type: 'button', text: 'Narrow dispatch budget' }), el('button', { class: 'danger', type: 'button', text: 'Revoke grant' })])]);
  const output = el('div');
  const reason = () => form.querySelector('input[name=reason]').value;
  const id = () => form.querySelector('select[name=id]').value;
  form.querySelector('.secondary').addEventListener('click', async () => { try { const result = await api(`/api/grants/${encodeURIComponent(id())}/narrow`, { method: 'POST', body: JSON.stringify({ reason: reason(), maxDispatchesPerWindow: 1 }) }); output.replaceChildren(outputBlock(result)); } catch (error) { output.replaceChildren(el('p', { class: 'muted', text: error.message })); } });
  form.querySelector('.danger').addEventListener('click', async () => { try { const result = await api(`/api/grants/${encodeURIComponent(id())}/revoke`, { method: 'POST', body: JSON.stringify({ reason: reason() }) }); output.replaceChildren(outputBlock(result)); } catch (error) { output.replaceChildren(el('p', { class: 'muted', text: error.message })); } });
  return el('div', {}, [form, output]);
}

function approvalForm() {
  return commandForm('Create approval', [['repo', 'Repository'], ['scope', 'Scope'], ['workClass', 'Work class'], ['runtime', 'Runtime'], ['profile', 'Profile'], ['actions', 'Actions (comma-separated)'], ['maxAttempts', 'Max attempts']], async (values) => {
    return api('/api/approvals', { method: 'POST', body: JSON.stringify({ ...values, actions: values.actions.split(',').map((value) => value.trim()).filter(Boolean), maxAttempts: Number(values.maxAttempts || 3), maxConcurrentRuns: 1, maxPaidCallUsd: 1 }) });
  });
}
function grantForm() {
  return commandForm('Create grant', [['repos', 'Repositories (comma-separated)'], ['workClasses', 'Classes (comma-separated)'], ['triggerSources', 'Trigger sources (comma-separated)'], ['actions', 'Actions (comma-separated)'], ['runtimes', 'Runtimes (comma-separated)'], ['profiles', 'Profiles (comma-separated)'], ['maxDispatchesPerWindow', 'Max dispatches'], ['reason', 'Reason']], async (values) => {
    const split = (value) => value.split(',').map((entry) => entry.trim()).filter(Boolean);
    return api('/api/grants', { method: 'POST', body: JSON.stringify({ ...values, repos: split(values.repos), workClasses: split(values.workClasses), triggerSources: split(values.triggerSources), actions: split(values.actions), runtimes: split(values.runtimes), profiles: split(values.profiles), maxDispatchesPerWindow: Number(values.maxDispatchesPerWindow || 1), maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1, windowHours: 24, maxAggregateConcurrentRuns: 1 }) });
  });
}
function commandForm(title, fields, submit) {
  const inputs = {};
  const form = el('form', {}, [el('h3', { text: title })]);
  for (const [name, label] of fields) { inputs[name] = el('input', { name }); form.append(el('label', { text: label }, [inputs[name]])); }
  form.append(el('button', { class: 'primary', type: 'submit', text: title }));
  form.addEventListener('submit', async (event) => { event.preventDefault(); try { const values = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value])); const result = await submit(values); form.append(outputBlock(result)); } catch (error) { showToast(error.message, true); } });
  return form;
}

async function renderSafety(current) {
  const [readiness, usage, ledger, versions] = await Promise.all([api('/api/runtimes/readiness'), api('/api/runtimes/usage'), api('/api/ledger'), api('/api/versions')]);
  if (!current()) return;
  app.replaceChildren(
    panel('Runtime readiness', [readinessTable(readiness.runtimes)]),
    panel('Subscription usage', [usageSummary(usage)]),
    panel('Policies and paid-call ledger', [policyForm(usage), ledgerForm(), el('p', { text: `Allowance: $${ledger.policy.allowanceUsd} · Remaining: $${Number(ledger.remainingUsd).toFixed(4)}` }), ledger.calls.length ? el('pre', { class: 'output', text: json(ledger.calls) }) : empty('No paid calls recorded.')]),
    panel('Version state', [versionForm(), el('p', { text: versions.active ? `Active coordinator: ${versions.active.coordinator}` : 'No version has been activated; this is an unactivated build.' }), el('pre', { class: 'output', text: json(versions) })]),
  );
}

function policyForm(usage) {
  const first = usage.runtimes[0];
  if (!first) return empty('No subscription policy is available until a runtime is configured.');
  return commandForm('Set subscription policy', [['subscriptionId', 'Subscription ID'], ['fiveHourThresholdPercent', 'Five-hour threshold %'], ['weeklyThresholdPercent', 'Weekly threshold %'], ['safetyMarginPercent', 'Safety margin %'], ['maxReadingAgeSeconds', 'Maximum reading age (seconds)']], async (values) => {
    values.subscriptionId = first.subscriptionId;
    values.fiveHourThresholdPercent = Number(values.fiveHourThresholdPercent);
    values.weeklyThresholdPercent = Number(values.weeklyThresholdPercent);
    values.safetyMarginPercent = Number(values.safetyMarginPercent);
    values.maxReadingAgeSeconds = Number(values.maxReadingAgeSeconds);
    return api(`/api/policies/${encodeURIComponent(values.subscriptionId)}`, { method: 'POST', body: JSON.stringify(values) });
  });
}

function ledgerForm() {
  return commandForm('Set paid-call allowance', [['allowanceUsd', 'Allowance USD']], async (values) => api('/api/ledger/policy', { method: 'POST', body: JSON.stringify({ allowanceUsd: Number(values.allowanceUsd) }) }));
}

function versionForm() {
  const form = commandForm('Activate a reviewed version', [['coordinator', 'Coordinator identity'], ['prompts', 'Prompt identity'], ['mergedPr', 'Merged PR URL']], async (values) => api('/api/versions/activate', { method: 'POST', body: JSON.stringify({ ...values, mergeConfirmed: true }) }));
  form.append(el('p', { class: 'muted small', text: 'Activation requires a reviewed merge URL and remains subject to the existing operator gate.' }));
  const rollback = el('button', { class: 'danger', type: 'button', text: 'Rollback to previous version' });
  rollback.addEventListener('click', async () => { try { const result = await api('/api/versions/rollback', { method: 'POST', body: '{}' }); form.append(outputBlock(result)); } catch (error) { form.append(el('p', { class: 'muted', text: error.message })); } });
  form.append(rollback);
  return form;
}

async function renderEvidence(current) {
  const evidence = await api('/api/evidence');
  if (!current()) return;
  const form = el('form', {}, [el('label', { text: 'Run ID' }, [el('input', { name: 'runId', placeholder: 'run_…' })]), el('button', { class: 'secondary', type: 'submit', text: 'List evidence' })]);
  const result = el('div');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const runId = form.querySelector('input').value.trim();
    try {
      const files = await api(`/api/evidence/runs/${encodeURIComponent(runId)}`);
      const list = el('ul', { class: 'list' });
      for (const file of files.files || []) {
        const view = el('button', { class: 'secondary', type: 'button', text: `View ${file.name}` });
        const content = el('pre', { class: 'output' });
        view.addEventListener('click', async () => { try { content.textContent = await apiText(file.url); } catch (error) { content.textContent = error.message; } });
        list.append(el('li', {}, [el('strong', { text: `${file.name} · ${file.bytes} bytes` }), view, content]));
      }
      result.replaceChildren(el('pre', { class: 'output', text: json(files) }), files.files?.length ? list : empty('No readable evidence files were recorded.'));
    } catch (error) { result.replaceChildren(el('p', { class: 'muted', text: error.message })); }
  });
  app.replaceChildren(panel('Required checks', [el('p', { text: evidence.requiredChecks.length ? `${evidence.requiredChecks.length} check(s) configured.` : 'No required checks are configured; acceptance is unavailable.' }), evidence.deferred.length ? el('p', { class: 'muted', text: `Deferred, therefore untested: ${evidence.deferred.join(', ')}` }) : null, el('pre', { class: 'output', text: json(evidence) })]), panel('Run evidence', [form, result]), panel('Record operator feedback', [commandForm('Feedback', [['scorecardId', 'Scorecard ID'], ['verdict', 'Verdict (accepted, rework-needed, rejected)'], ['reason', 'Reason']], async (values) => { const id = values.scorecardId; delete values.scorecardId; return api(`/api/scorecards/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: JSON.stringify(values) }); })]));
}


/* ------------------------------------------------------------------ console */

const stateLine = document.querySelector('#state-line');
const inboxCount = document.querySelector('#inbox-count');
const loopMark = document.querySelector('#loop-mark');

/** A light line for the idle and health states; the state name beside it stays literal. */
const MOOD = {
  'Nothing to do': 'No runnable work in the last pass.',
  Progress: 'Work is in progress.',
  Stalled: 'Work stalled. Inspect the fault before resuming.',
  Breach: 'A rule was broken. Inspect the fault before resuming.',
  'No pass yet': 'No pass has run against this store yet.',
  'Needs you': 'The loop state and your decisions are separate.',
  Blocked: 'Technical work is blocked. Inspect the reason.',
  Unknown: 'The latest store read failed. Refresh to retry.',
};

const ACTION_LABEL = {
  'apply-shaped': 'Apply shaped', 'apply-auto': 'Apply auto', merge: 'Merge now',
  'close-not-planned': 'Close as not planned', 'close-completed': 'Close as completed', 'release-claim': 'Release claim',
  'dismiss-fault': 'Dismiss fault', 'answer-escalation': 'Send answer', open: 'Open on GitHub',
};
const ALTERNATIVE = { 'apply-shaped': 'close-not-planned', 'apply-auto': 'close-not-planned' };

function age(seconds) {
  if (seconds === undefined || seconds === null) return 'unknown age';
  if (seconds < 90) return `${seconds}s old`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min old`;
  return `${Math.round(seconds / 3600)} h old`;
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function itemAge(item, snapshotAt) {
  const timestamp = item.updatedAt || item.createdAt;
  if (!timestamp) return 'Age unknown';
  const event = Date.parse(timestamp);
  const read = Date.parse(snapshotAt || '');
  if (!Number.isFinite(event) || !Number.isFinite(read)) return `Updated ${when(timestamp)} · age unknown`;
  const days = Math.floor(Math.max(0, read - event) / 86400000);
  return `Updated ${when(timestamp)} · ${days === 0 ? 'today' : `${days}d ago`} at read`;
}

function paintState(view) {
  if (!view) {
    stateLine.replaceChildren();
    loopMark.dataset.state = 'none';
    inboxCount.hidden = true;
    return;
  }
  const { board } = view;
  const s = board.state;
  loopMark.dataset.state = s.name.toLowerCase().replace(/\s+/g, '-');
  const needs = board.counts['Needs you'];
  const unknown = Boolean(board.stale) && !board.snapshotAt;
  inboxCount.textContent = String(needs);
  inboxCount.hidden = needs === 0 || unknown;
  stateLine.replaceChildren(
    el('span', { class: `state-pill state-${loopMark.dataset.state}`, text: s.name }),
    el('span', { class: 'state-detail' }, [
      el('span', { text: `Loop ${s.loop?.status || 'unknown'} · ${s.lastPass ? `last pass ${when(s.lastPass.endedAt)}` : 'no pass recorded'}` }),
      el('span', { class: 'mood', text: board.stale ? (unknown ? 'Store unknown; no previous read.' : 'Store read failed; showing older evidence.') : s.because || MOOD[s.name] || '' }),
    ]),
  );
}

async function loadConsole(current) {
  try {
    const view = await api('/api/console/view');
    if (!current()) return null;
    state.console = view;
    paintState(view);
    return view;
  } catch (error) {
    if (current()) {
      state.console = null;
      paintState(null);
    }
    throw error;
  }
}

function notConfigured() {
  return panel('No store to show', [
    el('p', { text: 'The console needs a target store. Start the UI with the repository it should watch:' }),
    el('pre', { class: 'output', text: 'agentsys ui --repo /path/to/target-repo' }),
    el('div', { class: 'actions' }, [el('button', { class: 'secondary', text: 'Open Advanced', onclick: async () => { state.view = 'advanced'; await renderView(); } })]),
  ]);
}

function staleBanner(board) {
  if (!board.stale) return null;
  return el('section', { class: 'banner warn', role: 'alert' }, [
    el('strong', { text: 'Stale: ' }),
    board.snapshotAt
      ? `the latest GitHub read failed (${board.stale.error}). Showing the snapshot taken ${when(board.snapshotAt)}, ${age(board.stale.ageSeconds)}. No verdict is derived from it.`
      : `the GitHub read failed (${board.stale.error}) and there is no earlier snapshot to show.`,
    el('button', { class: 'secondary', type: 'button', text: 'Refresh store', onclick: renderView }),
  ]);
}

function pausedBanner(board) {
  const paused = Object.entries(board.paused || {});
  if (paused.length === 0) return null;
  return el('section', { class: 'banner' }, [el('strong', { text: 'Paused: ' }), paused.map(([stage, p]) => `${stage} (by ${p.by}, ${when(p.at)})`).join(', ')]);
}

/** What kind of wait an item is, where it is not the common one; escalations and faults come first. */
const KIND = { 'answer-escalation': ['Escalation', 0], 'dismiss-fault': ['Fault', 1], open: ['Look', 2], 'release-claim': ['Assigned', 3] };
const rank = (item) => (KIND[item.action] ? KIND[item.action][1] : 9);
function kindBadge(item) {
  return KIND[item.action] ? el('span', { class: `kind kind-${item.action}`, text: KIND[item.action][0] }) : null;
}

const DECISION_GROUPS = [
  ['all', 'All decisions'], ['merge', 'Merge decisions'], ['proposal', 'Proposals'],
  ['assessment', 'Assessments'], ['blocker', 'Blockers'], ['other', 'Other decisions'],
];
function decisionGroup(item) {
  if (item.kind === 'pull' && item.because.includes('findings accepted')) return 'merge';
  if (item.action === 'apply-shaped') return 'proposal';
  if (item.action === 'apply-auto') return 'assessment';
  if (item.action === 'dismiss-fault' || item.action === 'answer-escalation' || item.because.includes('blocked')) return 'blocker';
  if (item.action === 'open' && item.kind === 'pull') return 'merge';
  return 'other';
}
function decisionItems(board) {
  return board.items.filter((item) => item.column === 'Needs you' || item.column === 'Ready to merge');
}
function decisionEvidence(data) {
  const nodes = (data.evidence || []).map((evidence) => el('section', { class: 'decision-document', 'aria-label': evidence.kind === 'review' ? 'Review and findings' : 'Current decision evidence' }, [
    el('h3', { text: evidence.kind === 'review' ? 'Review and findings' : evidence.kind === 'proposal' ? 'Proposed scope' : 'Assessment' }),
    el('p', { class: 'small muted', text: `${evidence.current === true ? 'Current' : evidence.current === false ? 'Outdated · refresh before acting' : 'Currentness not confirmed'} · posted ${when(evidence.createdAt)}` }),
    el('pre', { class: 'evidence-text', text: evidence.text }),
  ]));
  if (!nodes.length && data.review) nodes.push(el('section', { class: 'decision-document', 'aria-label': 'Review and findings' }, [
    el('h3', { text: 'Review and findings' }), el('p', { class: 'small muted mono', text: data.review.marker }),
    el('pre', { class: 'evidence-text', text: data.review.text }),
  ]));
  if (!nodes.length) nodes.push(el('p', { class: 'muted', text: 'Current decision evidence is unavailable here. Refresh the store read before deciding; do not treat this as a clean review.' }));
  return nodes;
}
function selectDecision(ref) {
  state.decisionRef = ref;
  state.decisionError = null;
  void renderView().then((current) => {
    if (!current || state.decisionRef !== ref) return;
    if (window.matchMedia('(max-width: 760px)').matches) document.querySelector('#decision-detail')?.scrollIntoView({ block: 'start' });
    document.querySelector('#decision-detail h2')?.focus({ preventScroll: true });
  });
}
function decisionDetail(data, board) {
  const { item } = data;
  const section = el('section', { id: 'decision-detail', class: 'decision-detail', 'aria-label': 'Selected decision' });
  const title = el('h2', { tabindex: '-1', text: item.title });
  const back = el('button', { class: 'secondary back-to-queue', type: 'button', text: '← Back to queue', onclick: () => {
    document.querySelector('.decision-list [aria-current="true"]')?.focus();
    document.querySelector('.decision-list [aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  } });
  const meta = el('dl', { class: 'decision-meta' }, [
    el('div', {}, [el('dt', { text: 'Decision owner' }), el('dd', { text: item.column === 'Ready to merge' ? 'Merge stage' : 'Operator' })]),
    el('div', {}, [el('dt', { text: 'Currentness' }), el('dd', { text: board.stale ? `Stale snapshot · ${age(board.stale.ageSeconds)}` : board.snapshotAt ? `Read ${when(board.snapshotAt)}` : 'Unknown' })]),
    el('div', {}, [el('dt', { text: 'Item age' }), el('dd', { text: data.itemAge ? `Opened ${when(data.itemAge)}${item.updatedAt ? ` · updated ${when(item.updatedAt)}` : ''}` : itemAge(item, board.snapshotAt) })]),
    el('div', {}, [el('dt', { text: 'Reference' }), el('dd', { text: item.ref })]),
  ]);
  const actionArea = el('footer', { class: 'decision-action' }, [
    el('h3', { text: item.action === 'open' ? 'Next: human review on GitHub' : `Next: ${ACTION_LABEL[item.action] || 'review this decision'}` }),
    el('p', { class: 'small', text: item.waitsFor || item.because }),
  ]);
  if (state.decisionError) actionArea.append(el('div', { class: 'refusal', role: 'alert' }, [
    el('strong', { text: 'Action refused · nothing changed' }),
    el('p', { text: `${state.decisionError} Refresh the evidence and try again only if it is still current.` }),
    el('button', { class: 'secondary', type: 'button', text: 'Refresh evidence', onclick: () => { state.decisionError = null; void renderView(); } }),
  ]));
  const requiredKind = item.action === 'apply-shaped' ? 'proposal' : item.action === 'apply-auto' ? 'assessment' : null;
  const missingEvidence = requiredKind && !(data.evidence || []).some((entry) => entry.kind === requiredKind && entry.text && entry.current === true);
  if (board.stale || missingEvidence) actionArea.append(el('p', { class: 'refusal', text: board.stale ? 'Actions are unavailable while the store read is stale. Refresh after the connection recovers.' : item.action === 'apply-auto' ? 'Assessment evidence is unavailable. Refresh Inspect or read the current assessment before granting auto. You can still close as not planned.' : 'The current proposal is unavailable. Refresh to read it before deciding; closing as not planned remains available.' }));
  const controls = el('div', { class: 'actions' });
  if (item.action === 'open') controls.append(el('a', { class: 'secondary button-link', href: item.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open for human decision ↗' }));
  else if (item.action) {
    const answer = item.action === 'answer-escalation' ? el('textarea', { 'aria-label': 'Answer posted on the ticket', placeholder: 'Your answer, posted on the ticket', rows: '3' }) : null;
    if (answer) {
      answer.value = state.answerDraft[item.ref] || '';
      answer.addEventListener('input', () => { state.answerDraft[item.ref] = answer.value; });
      actionArea.append(answer);
    }
    const verdict = verdictFields(item);
    if (verdict.node) actionArea.append(verdict.node);
    const act = (action) => async () => {
      const button = controls.querySelector(`[data-action="${action}"]`);
      button.disabled = true;
      try {
        const result = await api('/api/console/actions', { method: 'POST', body: JSON.stringify({ ref: item.ref, action,
          expected: data.actionToken,
          ...(answer ? { text: state.answerDraft[item.ref] || answer.value } : {}), ...(verdict.read() ? { verdict: verdict.read() } : {}),
        }) });
        state.decisionError = null;
        delete state.answerDraft[item.ref];
        showToast(`${item.ref}: ${result.data.did}`);
        await renderView();
      } catch (error) {
        state.decisionError = error.message;
        controls.hidden = true;
        button.disabled = false;
        const previous = actionArea.querySelector('.refusal[role="alert"]');
        previous?.remove();
        actionArea.insertBefore(el('div', { class: 'refusal', role: 'alert' }, [el('strong', { text: 'Action refused · nothing changed' }), el('p', { text: `${error.message} Refresh the evidence and try again only if it is still current.` }), el('button', { class: 'secondary', type: 'button', text: 'Refresh evidence', onclick: () => { state.decisionError = null; void renderView(); } })]), controls);
      }
    };
    controls.append(el('button', { class: 'primary', type: 'button', 'data-action': item.action, text: ACTION_LABEL[item.action], onclick: act(item.action), ...(board.stale || missingEvidence ? { disabled: '' } : {}) }));
    const alternative = ALTERNATIVE[item.action];
    if (alternative) controls.append(el('button', { class: 'secondary', type: 'button', 'data-action': alternative, text: ACTION_LABEL[alternative], onclick: act(alternative), ...(board.stale ? { disabled: '' } : {}) }));
  }
  controls.append(el('button', { class: 'secondary', type: 'button', text: 'Next decision →', onclick: () => {
    const items = decisionItems(board);
    const next = items[(items.findIndex((i) => i.ref === item.ref) + 1) % items.length];
    if (next) {
      state.decisionSearch = '';
      state.decisionGroup = 'all';
      selectDecision(next.ref);
    }
  } }));
  if (state.decisionError) controls.hidden = true;
  actionArea.append(controls);
  section.append(el('header', { class: 'decision-detail-head' }, [back, el('span', { class: 'small muted', text: `${item.ref} · ${board.stale ? 'older evidence' : 'latest read'}` })]),
    el('p', { class: 'eyebrow', text: DECISION_GROUPS.find(([key]) => key === decisionGroup(item))?.[1] || 'Decision' }), title,
    el('p', { class: 'decision-because', text: item.because }), meta,
    el('div', { class: 'decision-evidence' }, decisionEvidence(data)), actionArea);
  return section;
}
async function renderBoard(current) {
  const view = await loadConsole(current);
  if (!current()) return;
  const { board } = view;
  const decisions = decisionItems(board);
  if (!decisions.some((item) => item.ref === state.decisionRef)) state.decisionRef = decisions[0]?.ref || null;
  const unknown = board.stale && !board.snapshotAt;
  const counts = Object.fromEntries(DECISION_GROUPS.map(([key]) => [key, key === 'all' ? decisions.length : decisions.filter((item) => decisionGroup(item) === key).length]));
  const heading = el('header', { class: 'workspace-heading' }, [
    el('div', {}, [el('p', { class: 'eyebrow', text: 'Operator workspace' }), el('h2', { text: 'Decisions' }), el('p', { class: 'muted', text: 'Review the evidence. Choose what happens next.' })]),
    el('div', { class: 'workspace-summary' }, [
      el('strong', { text: unknown ? '—' : String(board.counts['Needs you']) }),
      el('span', { text: unknown ? 'decisions unknown' : 'need your decision' }),
      el('small', { text: unknown ? 'Merge readiness unknown · Store not yet read' : `${board.counts['Ready to merge']} ready for the merge stage · Store read ${when(board.snapshotAt)}` }),
    ]),
  ]);
  if (!decisions.length) {
    app.replaceChildren(...[staleBanner(board), pausedBanner(board), heading, panel(unknown ? 'Store unavailable' : 'No decisions waiting', [
      el('p', { text: unknown ? 'The store could not be read. Refresh to try again; no decision count is known.' : 'No decisions need you right now.' }),
      el('button', { class: 'secondary', type: 'button', text: 'Refresh', onclick: renderView }),
    ])].filter(Boolean));
    return;
  }
  const search = el('input', { type: 'search', placeholder: 'Title or issue number', 'aria-label': 'Find a decision', value: state.decisionSearch });
  const group = el('select', { 'aria-label': 'Decision group' }, DECISION_GROUPS.filter(([key]) => key === 'all' || counts[key]).map(([key, label]) => el('option', { value: key, text: `${label} · ${counts[key]}` })));
  group.value = counts[state.decisionGroup] ? state.decisionGroup : 'all';
  const list = el('div', { class: 'decision-list', 'aria-label': 'Decision queue' });
  const fill = () => {
    state.decisionSearch = search.value;
    state.decisionGroup = group.value;
    const matching = decisions.filter((item) => (group.value === 'all' || decisionGroup(item) === group.value) && `${item.ref} ${item.title}`.toLowerCase().includes(search.value.trim().toLowerCase()));
    const byGroup = group.value === 'all' ? DECISION_GROUPS.slice(1).filter(([key]) => matching.some((i) => decisionGroup(i) === key)) : [[group.value, DECISION_GROUPS.find(([key]) => key === group.value)?.[1]]];
    list.replaceChildren(...byGroup.map(([key, label]) => el('section', { 'aria-label': label }, [
      el('h3', { class: 'queue-group', text: `${label} · ${matching.filter((i) => decisionGroup(i) === key).length}` }),
      ...matching.filter((i) => decisionGroup(i) === key).map((item) => el('button', { class: 'decision-row', type: 'button', 'data-ref': item.ref, 'aria-current': item.ref === state.decisionRef ? 'true' : 'false', onclick: () => selectDecision(item.ref) }, [
        el('span', { class: 'decision-row-meta' }, [el('span', { text: item.ref }), el('span', { text: itemAge(item, board.snapshotAt) })]),
        el('strong', { text: item.title }), el('span', { class: 'muted small', text: item.waitsFor || item.because }),
      ])),
    ])));
    if (!matching.length) list.append(el('p', { class: 'muted', text: decisions.length ? 'No decisions match this search or group.' : unknown ? 'The store could not be read. Refresh to try again.' : 'No decisions need you right now.' }));
  };
  search.addEventListener('input', fill);
  group.addEventListener('change', fill);
  fill();
  const queue = el('section', { class: 'decision-queue', 'aria-label': 'Find a decision' }, [
    el('label', { text: 'Find a decision' }, [search]), el('label', { class: 'group-label', text: 'Decision group' }, [group]), list,
  ]);
  const layout = el('div', { class: 'decision-layout' }, [queue, el('section', { class: 'decision-detail pending', id: 'decision-detail', 'aria-label': 'Selected decision' }, [el('p', { text: state.decisionRef ? 'Loading decision evidence…' : 'Select a decision to inspect its evidence.' })])]);
  const activity = board.items.filter((item) => !decisions.includes(item));
  const outside = activity.length ? el('p', { class: 'off-board muted small' }, [
    `${activity.length} items outside the decision queue · `,
    el('button', { class: 'link', type: 'button', text: 'View activity', onclick: async () => { state.view = 'activity'; await renderView(); } }),
  ]) : null;
  app.replaceChildren(...[staleBanner(board), pausedBanner(board), heading, layout, outside].filter(Boolean));
  const selectedRef = state.decisionRef;
  if (selectedRef) {
    try {
      const data = await api(`/api/console/inspect?ref=${encodeURIComponent(selectedRef)}`);
      if (current() && state.decisionRef === selectedRef && data.item.ref === selectedRef) layout.replaceChild(decisionDetail(data, board), layout.lastElementChild);
    } catch (error) {
      if (current() && state.decisionRef === selectedRef) layout.lastElementChild.replaceChildren(el('p', { class: 'refusal', role: 'alert', text: `Evidence unavailable: ${error.message}. Refresh to retry; no action was taken.` }), el('button', { class: 'secondary', type: 'button', text: 'Refresh evidence', onclick: renderView }));
    }
  }
}

async function renderActivity(current) {
  const view = await loadConsole(current);
  if (!current()) return;
  const { board } = view;
  const items = board.items.filter((item) => !decisionItems(board).includes(item));
  const groups = ['Working', 'In review', 'not in play'];
  app.replaceChildren(...[
    staleBanner(board),
    el('header', { class: 'workspace-heading' }, [el('div', {}, [el('p', { class: 'eyebrow', text: 'Operator workspace' }), el('h2', { text: 'Activity' }), el('p', { class: 'muted', text: 'Loop work and queued items, separate from decisions that need you.' })])]),
    el('section', { class: 'activity-list', 'aria-label': 'Loop and queued work' }, [
      el('p', { class: 'muted', text: `Loop ${board.state.loop?.status || 'unknown'} · ${board.state.loop?.running || 0} recorded run(s) active · ${board.state.loop?.blocked || 0} technical blocker(s) in the last pass.` }),
      ...groups.filter((column) => items.some((item) => item.column === column)).map((column) => el('section', { class: 'panel', 'aria-label': column }, [
        el('h3', { text: `${column === 'not in play' ? 'Queued or outside the loop' : column} · ${items.filter((item) => item.column === column).length}` }),
        el('ul', { class: 'list' }, items.filter((item) => item.column === column).map((item) => el('li', {}, [
          el('button', { class: 'link', type: 'button', text: `${item.ref} ${item.title}`, onclick: () => openInspect(item.ref) }),
          el('p', { class: 'muted small', text: item.because }),
        ]))),
      ])),
      !items.length ? empty(board.stale && !board.snapshotAt ? 'Activity unknown until the store read recovers.' : 'No other work in this store.') : null,
    ]),
  ].filter(Boolean));
}

function verdictFields(item) {
  if (!item.cards.length) return { node: null, read: () => undefined };
  const cardSelect = el('select', { name: 'cardId' }, item.cards.map((id) => el('option', { value: id, text: id })));
  const verdict = el('select', { name: 'verdict' }, [el('option', { value: '', text: 'No verdict' }), ...['accepted', 'rework-needed', 'rejected'].map((v) => el('option', { value: v, text: v }))]);
  const reason = el('input', { name: 'reason', placeholder: 'Why, in a line' });
  const node = el('details', { class: 'verdict' }, [
    el('summary', { text: 'Add your verdict' }),
    el('div', { class: 'verdict-grid' }, [
      el('label', { text: 'On' }, [cardSelect]), el('label', { text: 'Verdict' }, [verdict]), el('label', { text: 'Reason' }, [reason]),
    ]),
  ]);
  return {
    node,
    read: () => (verdict.value ? { cardId: cardSelect.value, verdict: verdict.value, reason: reason.value } : undefined),
  };
}

async function performAction(item, action, extra, row) {
  row.classList.add('busy');
  try {
    const inspected = await api(`/api/console/inspect?ref=${encodeURIComponent(item.ref)}`);
    const result = await api('/api/console/actions', { method: 'POST', body: JSON.stringify({ ref: item.ref, action, expected: inspected.actionToken, ...extra }) });
    delete state.answerDraft[item.ref];
    showToast(`${item.ref}: ${result.data.did}${result.data.verdict ? ` · verdict ${result.data.verdict.verdict} recorded` : ''}`);
    await renderView();
  } catch (error) {
    row.classList.remove('busy');
    const slot = row.querySelector('.refusal');
    slot.textContent = error.message;
    slot.hidden = false;
  }
}

function inboxRow(item, stale = false, missingAssessment = false) {
  const row = el('li', { class: `inbox-row${item.column === 'Ready to merge' ? ' ready' : ''}`, 'data-ref': item.ref });
  const verdict = verdictFields(item);
  const answer = item.action === 'answer-escalation' ? el('textarea', { name: 'answer', placeholder: 'Your answer, posted on the ticket', rows: '3' }) : null;
  if (answer) {
    answer.value = state.answerDraft[item.ref] || '';
    answer.addEventListener('input', () => { state.answerDraft[item.ref] = answer.value; });
  }
  const buttons = el('div', { class: 'actions' });
  if (item.action === 'open') {
    buttons.append(el('a', { class: 'secondary button-link', href: item.url, target: '_blank', rel: 'noreferrer', text: ACTION_LABEL.open }));
  } else {
    buttons.append(el('button', { class: 'primary', type: 'button', 'data-action': item.action, text: ACTION_LABEL[item.action], onclick: () => performAction(item, item.action, {
      ...(answer ? { text: state.answerDraft[item.ref] || answer.value } : {}), ...(verdict.read() ? { verdict: verdict.read() } : {}),
    }, row) }));
    const alt = ALTERNATIVE[item.action];
    if (alt) buttons.append(el('button', { class: 'secondary', type: 'button', 'data-action': alt, text: ACTION_LABEL[alt], onclick: () => performAction(item, alt, verdict.read() ? { verdict: verdict.read() } : {}, row) }));
  }
  if (stale) for (const button of buttons.querySelectorAll('button[data-action]')) button.disabled = true;
  if (missingAssessment) buttons.querySelector('button[data-action="apply-auto"]').disabled = true;
  row.append(
    el('div', { class: 'inbox-main' }, [
      el('div', { class: 'inbox-title' }, [el('button', { class: 'link item-ref', type: 'button', text: item.ref, onclick: () => openInspect(item.ref) }), kindBadge(item), el('span', { text: ` ${item.title}` })]),
      el('p', { class: 'inbox-waits', text: `Waits for ${item.waitsFor}` }),
      el('p', { class: 'muted small', text: item.because }),
      missingAssessment ? el('p', { class: 'refusal', text: 'Assessment evidence unavailable. Refresh or inspect the assessment before granting auto; closing as not planned remains available.' }) : null,
      answer,
      verdict.node,
      el('p', { class: 'refusal', role: 'alert', hidden: '' }),
    ].filter(Boolean)),
    buttons,
  );
  return row;
}

async function renderInbox(current) {
  const view = await loadConsole(current);
  if (!current()) return;
  const items = view.board.items.filter((i) => i.column === 'Needs you').sort((a, b) => rank(a) - rank(b));
  const ready = view.board.items.filter((i) => i.column === 'Ready to merge');
  const unknown = Boolean(view.board.stale) && !view.board.snapshotAt;
  const assessmentAvailable = new Map();
  await Promise.all([...items, ...ready].filter((item) => item.action === 'apply-auto').map(async (item) => {
    try {
      const inspection = await api(`/api/console/inspect?ref=${encodeURIComponent(item.ref)}`);
      assessmentAvailable.set(item.ref, inspection.evidence?.some((entry) => entry.kind === 'assessment' && entry.text && entry.current === true));
    } catch { assessmentAvailable.set(item.ref, false); }
  }));
  if (!current()) return;
  app.replaceChildren(...[
    staleBanner(view.board),
    el('div', { class: 'section-head' }, [el('h2', { text: unknown ? 'Needs you (unknown)' : `Needs you (${items.length})` }), el('button', { class: 'secondary', type: 'button', text: 'Refresh', onclick: renderView })]),
    items.length ? el('ol', { class: 'inbox' }, items.map((item) => inboxRow(item, Boolean(view.board.stale), item.action === 'apply-auto' && !assessmentAvailable.get(item.ref))))
      : el('section', { class: 'panel quiet' }, [el('p', { text: unknown ? 'The store could not be read, so what waits on you is unknown. Refresh to try again.' : 'Inbox zero. Nothing waits on you.' })]),
    ready.length ? el('h2', { class: 'subhead', text: `Ready to merge (${ready.length}) — the loop merges these on its next pass` }) : null,
    ready.length ? el('ol', { class: 'inbox' }, ready.map((item) => inboxRow(item, Boolean(view.board.stale), item.action === 'apply-auto' && !assessmentAvailable.get(item.ref)))) : null,
  ].filter(Boolean));
}

function policyTable(rows, kind, extraHead, inputs) {
  const table = el('table', { class: 'policy' }, [el('thead', {}, [el('tr', {}, ['Row', 'Live', 'Proposed', ...extraHead, ''].map((h) => el('th', { text: h })))]), el('tbody')]);
  for (const row of rows) {
    const fields = inputs(row);
    const button = el('button', { class: 'secondary', type: 'button', text: 'Propose', onclick: async () => {
      button.disabled = true;
      try {
        const result = await api('/api/console/policy', { method: 'POST', body: JSON.stringify({ kind, ...fields.read() }) });
        showToast(`${result.data.opened ? 'Opened' : 'Updated'} PR #${result.data.pr} on ${result.data.branch}: ${result.data.live} → ${result.data.proposed}`);
        await renderView();
      } catch (error) {
        showToast(error.message, true);
        button.disabled = false;
      }
    } });
    table.querySelector('tbody').append(el('tr', { 'data-row': row.key }, [
      el('td', { text: row.key }),
      el('td', { class: 'live', text: row.live }),
      el('td', {}, [row.proposed ? el('span', { class: 'proposed', text: `${row.proposed.value} (proposed, PR #${row.proposed.pr})` }) : el('span', { class: 'muted', text: '—' })]),
      ...fields.cells,
      el('td', {}, [button]),
    ]));
  }
  return table;
}

async function renderSteer(current) {
  let steer;
  try {
    steer = await api('/api/console/steer');
  } catch (error) {
    if (current() && error.code === 'console-not-configured') return app.replaceChildren(notConfigured());
    throw error;
  }
  if (!current()) return;
  const stopLines = policyTable(steer.policy.stopLines, 'stop-line', ['New value'], (row) => {
    const input = el('input', { type: 'number', min: '0', max: '20', value: /^\d+$/.test(row.live) ? row.live : '', 'aria-label': `New stop-line for ${row.key}` });
    return { cells: [el('td', {}, [input])], read: () => ({ label: row.key, value: Number(input.value) }) };
  });
  const tiers = policyTable(steer.policy.tiers, 'tier', ['Runtime', 'Model', 'Effort', '5h %', 'Weekly %'], (row) => {
    const [runtime = '', model = '', effort = '', five = '', weekly = ''] = row.live.split(' · ');
    const input = (value, label, type = 'text') => el('input', { type, value: value.replace('%', ''), 'aria-label': `${label} for ${row.key}` });
    const f = { runtime: input(runtime, 'Runtime'), model: input(model, 'Model'), effort: input(effort, 'Effort'), five: input(five, 'Five-hour %', 'number'), weekly: input(weekly, 'Weekly %', 'number') };
    // A stage lists one row per runtime, so the runtime says which row this is and is not edited here.
    f.runtime.readOnly = true;
    return {
      cells: Object.values(f).map((i) => el('td', {}, [i])),
      read: () => ({ stage: row.stage, runtime, model: f.model.value, effort: f.effort.value, fiveHourPercent: Number(f.five.value), weeklyPercent: Number(f.weekly.value) }),
    };
  });
  const limits = el('table', { class: 'policy' }, [el('thead', {}, [el('tr', {}, ['Setting', 'Live', 'Proposed'].map((h) => el('th', { text: h })))]),
    el('tbody', {}, steer.policy.limits.map((row) => el('tr', { 'data-row': row.key }, [el('td', { text: row.key }), el('td', { class: 'live', text: row.live }), el('td', { text: row.proposed ? `${row.proposed.value} (proposed, PR #${row.proposed.pr})` : '—' })])))]);

  const stages = el('ul', { class: 'stage-list' }, steer.stages.map((stage) => {
    const paused = steer.paused[stage];
    return el('li', { 'data-stage': stage }, [
      el('span', { class: 'stage-name', text: stage }),
      el('span', { class: paused ? 'status warn' : 'status ok', text: paused ? `paused by ${paused.by}, ${when(paused.at)}` : 'running' }),
      el('button', { class: 'secondary', type: 'button', text: paused ? 'Resume' : 'Pause', onclick: async () => {
        try {
          await api(`/api/console/stages/${stage}/${paused ? 'resume' : 'pause'}`, { method: 'POST', body: '{}' });
          showToast(`${stage} ${paused ? 'resumed' : 'paused'}; the next pass reads it`);
          await renderView();
        } catch (error) { showToast(error.message, true); }
      } }),
    ]);
  }));

  const runs = el('table', { class: 'runs' }, [el('thead', {}, [el('tr', {}, ['Run', 'Task', 'Runtime', 'Status', 'Started', ''].map((h) => el('th', { text: h })))]), el('tbody')]);
  for (const run of steer.runs) {
    const running = run.status === 'running';
    const button = el('button', { class: running ? 'danger' : 'secondary', type: 'button', text: running ? 'Stop' : 'Redispatch', onclick: async () => {
      button.disabled = true;
      try {
        const result = await api(`/api/console/runs/${run.id}/${running ? 'stop' : 'redispatch'}`, { method: 'POST', body: '{}' });
        showToast(running ? `Stopped ${run.id} (${result.data.taskId}), recorded as stopped by ${result.data.stoppedBy}` : `Redispatch of ${run.taskId} started (${result.id})`);
        await renderView();
      } catch (error) {
        showToast(error.message, true);
        button.disabled = false;
      }
    } });
    runs.querySelector('tbody').append(el('tr', { 'data-run': run.id }, [
      el('td', { text: run.id }), el('td', { text: run.taskId }), el('td', { text: run.runtime }), el('td', {}, [statusBadge(run.status)]), el('td', { text: when(run.startedAt) }), el('td', {}, [button]),
    ]));
  }

  app.replaceChildren(
    panel('Stop-lines', [el('p', { class: 'muted small', text: `Live from ${steer.policy.source}. A change opens a pull request against the base branch; the loop reads only merged policy.` }), stopLines]),
    panel('Stage tiers', [tiers]),
    panel('Loop limits', [limits]),
    panel('Stages', [stages]),
    panel('Runs', [steer.runs.length ? runs : empty('No loop runs recorded.')]),
  );
}

function openInspect(ref) {
  state.inspectRef = ref;
  state.view = 'inspect';
  void renderView();
}

function trustTable(trust) {
  const head = ['Stage', 'Runs', 'Independent reviews', 'Reviews', 'Findings', 'Fix rounds (PRs cleaned)', 'Escalations', 'Merges to dev',
    'Derived: accepted / rework / rejected', 'Explicit: accepted / rework / rejected'];
  const tally = (t) => `${t.accepted} / ${t['rework-needed']} / ${t.rejected}`;
  return el('table', { class: 'trust' }, [
    el('thead', {}, [el('tr', {}, head.map((h) => el('th', { text: h })))]),
    el('tbody', {}, trust.rows.map((r) => el('tr', { 'data-stage': r.stage }, [
      el('td', { text: r.stage }), el('td', { text: String(r.runs) }), el('td', { text: String(r.independentReviews) }), el('td', { text: String(r.reviews) }),
      el('td', { text: String(r.findings) }), el('td', { text: `${r.fixRounds} (${r.pullsCleaned})` }), el('td', { text: String(r.escalations) }), el('td', { text: String(r.mergesToDev) }),
      el('td', { class: 'derived', text: tally(r.verdicts.derived) }), el('td', { class: 'explicit', text: tally(r.verdicts.explicit) }),
    ]))),
  ]);
}

async function evidenceList(runId) {
  const box = el('div', { class: 'evidence' }, [el('p', { class: 'muted small', text: `Run ${runId}` })]);
  try {
    const files = await api(`/api/evidence/runs/${encodeURIComponent(runId)}`);
    const list = el('ul', { class: 'list' });
    for (const file of files.files || []) {
      const content = el('pre', { class: 'output', hidden: '' });
      list.append(el('li', {}, [
        el('button', { class: 'link', type: 'button', text: `${file.name} · ${file.bytes} bytes`, onclick: async () => {
          try { content.textContent = await apiText(file.url); } catch (error) { content.textContent = error.message; }
          content.hidden = false;
        } }),
        content,
      ]));
    }
    box.append(files.files?.length ? list : empty('No readable evidence files were recorded.'));
  } catch (error) {
    box.append(empty(error.message));
  }
  return box;
}

/** What each case kind can observe, the expected one first — the oracle's own list. */
const CASE_OUTCOMES = {
  'reviewer-detects-bad-candidate': ['defect-reported', 'defect-missed'],
  'approved-repair': ['completed', 'not-completed'],
  'approved-feature': ['completed', 'not-completed'],
  'refusal-or-pending': ['refused-or-pending', 'proceeded'],
};

function freezeForm(item) {
  const kind = el('select', { name: 'kind' }, Object.keys(CASE_OUTCOMES).map((k) => el('option', { value: k, text: k })));
  if (item.kind === 'issue') kind.value = 'refusal-or-pending';
  const expected = el('select', { name: 'expected' });
  const pattern = el('input', { name: 'defectPattern', placeholder: 'e.g. sync.ts' });
  const patternLabel = el('label', { text: 'A finding counts as reporting the defect when it contains' }, [pattern]);
  const fill = () => {
    expected.replaceChildren(...CASE_OUTCOMES[kind.value].map((o) => el('option', { value: o, text: o })));
    patternLabel.hidden = kind.value !== 'reviewer-detects-bad-candidate';
  };
  kind.addEventListener('change', fill);
  fill();
  const words = el('textarea', { name: 'words', rows: '3', placeholder: 'What should have happened, in your words' });
  const result = el('div');
  const form = el('form', { class: 'freeze' }, [
    el('div', { class: 'form-grid' }, [el('label', { text: 'Kind' }, [kind]), el('label', { text: 'Expected outcome' }, [expected])]),
    el('label', { text: 'The expectation, in your words' }, [words]),
    patternLabel,
    el('div', { class: 'actions' }, [el('button', { class: 'primary', type: 'submit', text: 'Freeze as case' })]),
    result,
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const response = await api('/api/console/cases', { method: 'POST', body: JSON.stringify({
        ref: item.ref, kind: kind.value, expected: expected.value, words: words.value,
        ...(kind.value === 'reviewer-detects-bad-candidate' ? { defectPattern: pattern.value } : {}),
      }) });
      const d = response.data;
      result.replaceChildren(el('p', { class: 'small' }, [el('strong', { text: `Frozen: ${d.caseId}` }), ` in suite ${d.version} (${d.cases} case(s), oracle ${d.oracleDigest.slice(0, 12)})`]),
        el('pre', { class: 'output', text: Object.entries(d.pins).map(([k, v]) => `${k}: ${v}`).join('\n') }));
      showToast(`Frozen ${d.caseId} into ${d.version}`);
    } catch (error) {
      result.replaceChildren(el('p', { class: 'refusal', text: error.message }));
    }
  });
  return form;
}

async function renderInspect(current) {
  const ref = state.inspectRef;
  if (!ref) {
    const view = await loadConsole(current);
    if (!current()) return;
    const refInput = el('input', { name: 'ref', placeholder: 'PR #120 or #118', 'aria-label': 'Item to inspect' });
    const open = el('form', { class: 'inline-form' }, [refInput, el('button', { class: 'secondary', type: 'submit', text: 'Inspect' })]);
    open.addEventListener('submit', (event) => { event.preventDefault(); if (refInput.value.trim()) openInspect(refInput.value.trim()); });
    app.replaceChildren(panel('Inspect', [
      el('p', { class: 'muted', text: 'Pick an item on the Board or in the Inbox, choose one here, or name any item of the store — a merged pull request too.' }),
      open,
      el('ul', { class: 'off-list' }, view.board.items.map((i) => el('li', {}, [el('button', { class: 'link', type: 'button', text: i.ref, onclick: () => openInspect(i.ref) }), ` ${i.title} `, el('span', { class: 'muted', text: `· ${i.column}` })]))),
    ]));
    return;
  }
  const data = await api(`/api/console/inspect?ref=${encodeURIComponent(ref)}`);
  if (!current() || state.inspectRef !== ref) return;
  const verdicts = (state.console?.board.verdicts || []).filter((v) => data.item.cards.includes(v.cardId));
  const cards = el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Scorecard', 'Stage', 'Tier', 'Prompt', 'Status', 'Checks', 'Created'].map((h) => el('th', { text: h })))]),
    el('tbody', {}, data.cards.map((c) => el('tr', {}, [
      el('td', { text: c.id }), el('td', { text: c.loop ? c.loop.stage : '—' }), el('td', { text: c.tier }),
      el('td', { class: 'mono', text: c.prompt ? `${c.prompt.template} ${c.prompt.short}` : 'not recorded' }),
      el('td', {}, [statusBadge(c.finalStatus)]),
      el('td', { text: c.checks.length ? c.checks.map((k) => `${k.name}: ${k.outcome}`).join(', ') : 'none recorded' }),
      el('td', { text: when(c.createdAt) }),
    ]))),
  ]);
  const verdictList = el('ul', { class: 'list verdicts' }, verdicts.map((v) => el('li', { 'data-source': v.source }, [
    el('span', { class: `source ${v.source}`, text: v.source }), ` ${v.cardId} · ${v.verdict}${v.superseded ? ' · superseded, kept' : ''} — ${v.detail}`,
  ])));
  const trust = data.trust;
  const runEvidence = data.run ? await evidenceList(data.run.id) : empty('No run recorded for this item.');
  if (!current() || state.inspectRef !== ref) return;
  app.replaceChildren(
    el('div', { class: 'section-head' }, [
      el('h2', { text: `${data.item.ref} ${data.item.title}` }),
      el('div', { class: 'actions' }, [el('a', { class: 'secondary button-link', href: data.item.url, target: '_blank', rel: 'noreferrer', text: 'Open on GitHub' }), el('button', { class: 'secondary', type: 'button', text: 'Inspect another', onclick: async () => { state.inspectRef = null; await renderView(); } })]),
    ]),
    panel('Where it stands', [el('p', {}, [el('strong', { text: data.item.column }), ` — ${data.item.because}`]), data.item.waitsFor ? el('p', { class: 'muted', text: `Waits for ${data.item.waitsFor}` }) : null]),
    panel('Decision evidence', data.evidence?.length ? decisionEvidence(data) : [empty('No current proposal, assessment or review evidence was returned. Refresh before deciding.')]),
    panel('Scorecards', [data.cards.length ? cards : empty('No scorecard is about this item yet.'), verdicts.length ? verdictList : empty('No verdict on these scorecards yet.')]),
    panel('Evidence', [runEvidence]),
    panel('Recorded attempts and build', [
      el('p', { class: 'small muted', text: data.buildIdentity?.loadedMatchesDisk === false ? 'Running build differs from files on disk. Check the loaded identity before drawing a conclusion.' : 'Loaded and selected build identities are reported separately; unknown is not a match.' }),
      el('pre', { class: 'output', text: json(data.buildIdentity || {}) }),
      data.attempts?.length ? el('ul', { class: 'list' }, data.attempts.map((run) => el('li', {}, [
        el('strong', { text: `${run.id} · runtime ${run.status} · delivery ${run.delivery?.status || 'unknown'}${run.delivery?.source === 'operator-attested' ? ' · operator-attested (not automatic proof)' : ''}` }),
        el('p', { class: 'small muted', text: `${run.delivery?.by ? `Attested by ${run.delivery.by}. ` : ''}${run.delivery?.reason || 'No verified delivery recorded.'}` }),
        el('p', { class: 'small mono', text: `Build: ${run.build?.digest || 'unknown'} · dispatched: ${run.runtimeDispatched === undefined ? 'unknown' : run.runtimeDispatched ? 'yes' : 'no'}` }),
      ]))) : empty('No recorded attempts for this item.'),
    ]),
    panel(`Trust: ${trust.workType}`, [
      el('p', { class: 'small' }, [el('strong', { text: `Stop-line in force: ${trust.stopLine}` }), el('span', { class: 'muted', text: ` · ${trust.stopLineSource}` })]),
      trust.rows.length ? trustTable(trust) : empty('No scorecard records loop work of this type yet.'),
      el('p', { class: 'muted small', text: 'Counts only. Derived verdicts are read from what was done on GitHub; explicit ones are what you said. Neither is folded into the other.' }),
    ]),
    panel('Freeze as case', [
      el('p', { class: 'muted small', text: 'Pins this item\'s inputs — head, base, ticket body hash, review marker, the prompt and tier behind the run — with the outcome you expect, into a new frozen suite version. A trial can then replay it against another prompt or tier.' }),
      freezeForm(data.item),
    ]),
  );
}

/* ------------------------------------------------------------------ advanced: the earlier views, unchanged */

const ADVANCED = [['overview', 'Overview'], ['work', 'Work'], ['authority', 'Authority'], ['safety', 'Safety'], ['evidence', 'Evidence']];

async function renderAdvanced(current) {
  const render = { overview: renderOverview, work: renderWork, authority: renderAuthority, safety: renderSafety, evidence: renderEvidence }[state.advanced];
  await render(current);
  if (!current()) return;
  app.prepend(el('nav', { class: 'subnav', 'aria-label': 'Advanced' }, ADVANCED.map(([key, label]) => el('button', {
    class: `nav-button${state.advanced === key ? ' active' : ''}`, 'data-advanced': key, text: label,
    onclick: async () => { state.advanced = key; await renderView(); },
  }))));
}

async function renderView() {
  const generation = ++renderGeneration;
  const view = state.view;
  const current = () => generation === renderGeneration && state.view === view;
  document.querySelectorAll('.nav .nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  app.replaceChildren(el('section', { class: 'panel loading' }, [el('p', { text: 'Loading…' })]));
  try {
    if (view === 'board') await renderBoard(current);
    if (view === 'inbox') await renderInbox(current);
    if (view === 'activity') await renderActivity(current);
    if (view === 'steer') await renderSteer(current);
    if (view === 'inspect') await renderInspect(current);
    if (view === 'advanced') await renderAdvanced(current);
  } catch (error) {
    if (!current()) return false;
    if (error.code === 'console-not-configured') app.replaceChildren(notConfigured());
    else app.replaceChildren(panel('UI error', [el('p', { class: 'muted', text: error.message })]));
  }
  return current();
}

document.querySelectorAll('.nav .nav-button').forEach((button) => button.addEventListener('click', async () => { state.view = button.dataset.view; await renderView(); }));
// A new bootstrap link pasted into a tab already on this page changes only the hash, which does not reload it.
window.addEventListener('hashchange', () => {
  if (/(?:^|#)bootstrap=/.test(window.location.hash)) {
    bootstrap().catch((error) => { sessionStatus.textContent = 'Not connected'; app.replaceChildren(panel('Connect to the local UI', [el('p', { text: error.message })])); });
  }
});
bootstrap().catch((error) => { sessionStatus.textContent = 'Not connected'; app.replaceChildren(panel('Connect to the local UI', [el('p', { text: error.message }), el('p', { class: 'muted', text: 'Use the bootstrap URL printed by node dist/ui/server.js. Setup and configuration remain CLI-only.' })])); });
