const $ = (selector) => document.querySelector(selector);
let token = sessionStorage.getItem("log-archive-token") || "";
let sourceItems = [];
let editingId = null;

const api = async (route, options = {}) => {
  const response = await fetch(route, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new Error(problem.detail || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
};

const bytes = (value) => {
  if (value === null || value === undefined) return "Unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
};
const date = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle:"medium", timeStyle:"short" }).format(new Date(value)) : "Never";
const escape = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character]);

async function refresh() {
  const [status, sources, audit] = await Promise.all([api("/api/v1/status"), api("/api/v1/sources"), api("/api/v1/audit")]);
  $("#source-count").textContent = status.sourceCount;
  $("#enabled-count").textContent = `${status.enabledSourceCount} enabled`;
  $("#spool-bytes").textContent = bytes(status.spool.bytes);
  $("#spool-limit").textContent = `${bytes(status.spool.maxBytes)} capacity`;
  $("#pending-count").textContent = status.spool.pending;
  $("#failed-count").textContent = `${status.spool.failed} failed`;
  $("#restore-status").textContent = status.lastRestoreVerification?.result || "Pending";
  $("#restore-time").textContent = status.lastRestoreVerification ? date(status.lastRestoreVerification.verifiedAt) : "Not yet verified";
  sourceItems = sources.items;
  $("#sources").innerHTML = sources.items.length ? sources.items.map((source) => `
    <tr><td><strong>${escape(source.name)}</strong><small>${escape(source.path)}</small></td><td><span class="state ${escape(source.health)}">${escape(source.health)}</span></td><td>${bytes(source.activeBytes)}</td><td>${date(source.executions[0]?.completedAt)}</td><td>${source.pendingSegments}</td><td><div class="source-actions"><button class="secondary rotate" data-id="${escape(source.id)}">Rotate</button><button class="secondary edit" data-id="${escape(source.id)}">Edit</button><button class="secondary delete" data-id="${escape(source.id)}">Delete</button></div></td></tr>
  `).join("") : '<tr><td colspan="6" class="empty">No sources configured. Add an explicitly mounted log file to begin.</td></tr>';
  $("#audit").innerHTML = audit.items.length ? audit.items.map((entry) => `<li><time>${date(entry.at)}</time><span><strong>${escape(entry.action)}</strong><br><small>${escape(entry.target)}</small></span><small>${escape(entry.result)}</small></li>`).join("") : '<li class="empty">No activity yet.</li>';
  document.querySelectorAll(".rotate").forEach((button) => button.addEventListener("click", () => action(button, `/api/v1/sources/${button.dataset.id}/rotate`, "Rotation accepted")));
  document.querySelectorAll(".edit").forEach((button) => button.addEventListener("click", () => openSourceDialog(sourceItems.find((source) => source.id === button.dataset.id))));
  document.querySelectorAll(".delete").forEach((button) => button.addEventListener("click", () => deleteSource(button)));
}

async function connect(event) {
  event?.preventDefault();
  token = $("#token").value || token;
  try {
    await refresh();
    sessionStorage.setItem("log-archive-token", token);
    $("#session").hidden = true;
    $("#workspace").hidden = false;
    $("#session-button").textContent = "Disconnect";
  } catch (error) {
    sessionStorage.removeItem("log-archive-token"); token = ""; show(error.message, true);
  }
}

async function action(button, route, message) {
  button.disabled = true;
  try { await api(route, { method:"POST" }); show(message); await refresh(); }
  catch (error) { show(error.message, true); }
  finally { button.disabled = false; }
}

function openSourceDialog(source = null) {
  editingId = source?.id || null;
  $("#source-form").reset();
  $("#source-id").disabled = Boolean(source);
  $("#dialog-title").textContent = source ? "Edit managed file" : "Add a managed file";
  $("#save-source").textContent = source ? "Save changes" : "Create source";
  if (source) {
    for (const name of ["id", "name", "path", "maxBytes", "intervalSeconds", "strategy", "reopenUrl"]) {
      const field = $("#source-form").elements.namedItem(name); if (field) field.value = source[name] ?? "";
    }
    $("#source-form").elements.namedItem("copytruncateWarningAccepted").checked = source.copytruncateWarningAccepted;
    $("#source-form").elements.namedItem("enabled").checked = source.enabled;
  }
  $("#copy-warning").hidden = (source?.strategy || "rename-create") !== "copytruncate";
  $("#source-dialog").showModal();
}

async function deleteSource(button) {
  const source = sourceItems.find((item) => item.id === button.dataset.id);
  if (!source || !confirm(`Delete source policy “${source.name}”? Archived segments are retained.`)) return;
  button.disabled = true;
  try { await api(`/api/v1/sources/${source.id}`, { method:"DELETE" }); show("Source deleted"); await refresh(); }
  catch (error) { show(error.message, true); }
  finally { button.disabled = false; }
}

function show(message, error = false) {
  const toast = $("#toast"); toast.textContent = message; toast.style.background = error ? "#ffe7e9" : "#edfdf7"; toast.classList.add("visible"); setTimeout(() => toast.classList.remove("visible"), 4000);
}

$("#session-form").addEventListener("submit", connect);
$("#session-button").addEventListener("click", () => {
  if (!token) return $("#token").focus();
  token = ""; sessionStorage.removeItem("log-archive-token"); $("#workspace").hidden = true; $("#session").hidden = false; $("#session-button").textContent = "Connect";
});
$("#add-button").addEventListener("click", () => openSourceDialog());
$("#close-dialog").addEventListener("click", () => $("#source-dialog").close());
$("#cancel-dialog").addEventListener("click", () => $("#source-dialog").close());
$("#source-strategy").addEventListener("change", (event) => { $("#copy-warning").hidden = event.target.value !== "copytruncate"; });
$("#source-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = new FormData(event.currentTarget); const submit = event.submitter; submit.disabled = true; $("#form-error").textContent = "";
  const document = Object.fromEntries(form); document.id = editingId || document.id; document.maxBytes = Number(document.maxBytes); document.intervalSeconds = Number(document.intervalSeconds); document.enabled = form.has("enabled"); document.copytruncateWarningAccepted = form.has("copytruncateWarningAccepted");
  try { await api(editingId ? `/api/v1/sources/${editingId}` : "/api/v1/sources", { method:editingId ? "PUT" : "POST", body:JSON.stringify(document) }); $("#source-dialog").close(); event.currentTarget.reset(); show(editingId ? "Source updated" : "Source created"); editingId = null; await refresh(); }
  catch (error) { $("#form-error").textContent = error.message; }
  finally { submit.disabled = false; }
});
$("#retry-button").addEventListener("click", (event) => action(event.currentTarget, "/api/v1/archive/retry", "Archive retry complete"));
$("#verify-button").addEventListener("click", (event) => action(event.currentTarget, "/api/v1/restore-verifications", "Restore verification passed"));
if (token) connect();
