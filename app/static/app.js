const $ = selector => document.querySelector(selector);
const money = value => `K${Number(value || 0).toFixed(2)}`;
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));
const dateTime = value => value ? new Date(`${value}Z`).toLocaleString() : "—";
const formatDate = value => value ? new Date(`${value}Z`).toLocaleDateString() : "—";
const state = { customers: [], orders: [], products: [], services: [], user: null, documentId: null, aiAvailable: null };
let progressTarget = null;
let toastTimer;
let editorUndo = [];
let editorRedo = [];
let previousEditorText = "";

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith("/api/auth/")) {
      state.user = null;
      window.location.replace("/login");
    }
    const detail = data.detail;
    throw new Error(Array.isArray(detail) ? detail.map(item => item.msg).join(", ") : detail || "Request failed");
  }
  return data;
}

function showMessage(selector, message, error = false) {
  const element = $(selector);
  if (!element) return;
  element.textContent = message;
  element.className = `form-message${error ? " error" : ""}`;
}

function notify(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("visible"), 3500);
}

function tableMarkup(headers, rows, emptyMessage) {
  if (!rows.length) return `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
  return `<table><thead><tr>${headers.map(header => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function updateListMarkup(updates) {
  if (!updates.length) return `<div class="empty-state">Job milestones will appear here as work progresses.</div>`;
  return `<ol class="job-update-timeline">${updates.map(update => `
    <li class="job-update-item">
      <span class="timeline-marker status-${escapeHtml(update.status)}"></span>
      <div class="timeline-copy">
        <div class="timeline-title"><strong>${escapeHtml(update.status.replaceAll("_", " "))}</strong><time>${escapeHtml(dateTime(update.created_at))}</time></div>
        <p>${escapeHtml(update.message)}</p>
        ${update.whatsapp_status && update.whatsapp_status !== "not_applicable"
          ? `<small class="timeline-delivery">WhatsApp: ${escapeHtml(update.whatsapp_status.replaceAll("_", " "))}${update.whatsapp_error ? ` · ${escapeHtml(update.whatsapp_error)}` : ""}</small>`
          : ""}
      </div>
    </li>`).join("")}</ol>`;
}

function completionDelivery(status) {
  if (status === "sent") return "WhatsApp message sent.";
  if (status === "not_opted_in") return "In-app update saved; WhatsApp was skipped because the customer did not opt in.";
  if (status === "not_configured") return "In-app update saved; WhatsApp delivery is not configured.";
  if (status === "failed") return "In-app update saved; WhatsApp delivery failed. Check the admin activity log.";
  return "Customer portal updated.";
}

async function showJobHistory(type, id) {
  try {
    const query = new URLSearchParams({ job_type: type, job_id: id });
    const updates = await api(`/api/job-updates?${query}`);
    $("#jobHistoryTitle").textContent = `${type === "print" ? "Print job" : type === "document" ? "Document job" : "T-shirt order"} #${id}`;
    $("#jobHistoryList").innerHTML = updateListMarkup(updates);
    $("#jobHistoryDialog").showModal();
  } catch (error) {
    notify(error.message, true);
  }
}

function openProgressUpdate(type, id) {
  progressTarget = { type, id };
  const jobNames = { print: "Print job", document: "Document job", tshirt: "T-shirt order" };
  $("#progressUpdateTitle").textContent = `${jobNames[type]} #${id} · customer update`;
  $("#progressUpdateForm").reset();
  showMessage("#progressUpdateMsg", "");
  $("#progressUpdateDialog").showModal();
  $("#progressUpdateMessage").focus();
}

function documentNextAction(job) {
  if (["uploaded", "text_extracted", "edited"].includes(job.status)) {
    return `<button class="table-action work-action" data-document-next="in_progress" data-document-id="${job.id}">Start processing</button>`;
  }
  const next = {
    in_progress: ["ready", "Mark ready"],
    ready: ["completed", "Complete job"]
  }[job.status];
  return next
    ? `<button class="table-action work-action" data-document-next="${next[0]}" data-document-id="${job.id}">${next[1]}</button>`
    : escapeHtml(job.status.replaceAll("_", " "));
}

function updateEditorWordCount() {
  const text = $("#documentEditorText").value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  $("#editorWordCount").textContent = `${words.toLocaleString()} ${words === 1 ? "word" : "words"} · ${text.length.toLocaleString()} characters`;
}

async function openDocumentEditor(jobId, aiRequest = null) {
  try {
    const job = await api(`/api/documents/${jobId}/editor`);
    state.documentId = job.id;
    $("#editorFilename").textContent = job.filename;
    $("#documentEditorText").value = job.text;
    $("#documentEditorText").style.fontFamily = $("#editorFont").value;
    $("#documentEditorText").style.fontSize = `${$("#editorFontSize").value}pt`;
    editorUndo = [];
    editorRedo = [];
    previousEditorText = job.text;
    $("#editorAIAction").value = aiRequest?.action || "coach";
    $("#editorAIInstruction").value = aiRequest?.instruction || "";
    updateEditorWordCount();
    showMessage("#editorMessage", "");
    $("#documentEditorDialog").showModal();
    $("#documentEditorText").focus();
    if (aiRequest?.autoRun) await runDocumentAI();
  } catch (error) {
    notify(error.message, true);
  }
}

function switchView(name) {
  document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll(".nav-link").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  const active = document.querySelector(`.nav-link[data-view="${name}"]`);
  $("#pageTitle").textContent = active ? active.textContent.trim() : "Overview";
  if (window.matchMedia("(max-width: 620px)").matches) {
    window.scrollTo({ top: 0, behavior: "auto" });
  } else {
    $(".main-content").scrollTo({ top: 0, behavior: "auto" });
  }
}

async function enterWorkspace(user) {
  state.user = user;
  document.body.classList.add("authenticated");
  $("#signedInName").textContent = user.name;
  $("#signedInRole").textContent = `${user.role.charAt(0).toUpperCase()}${user.role.slice(1)} panel`;
  $("#accountChip").textContent = `${user.name} · ${user.role}`;
  document.querySelectorAll("[data-roles]").forEach(element => {
    element.hidden = !element.dataset.roles.split(/\s+/).includes(user.role);
    element.style.display = element.hidden ? "none" : "";
  });
  if (user.role === "customer") {
    switchView("customer");
    await loadCustomerPortal();
  } else {
    switchView("overview");
    const heading = $("#view-overview .page-heading h1");
    const description = $("#view-overview .page-heading p");
    heading.textContent = user.role === "admin" ? "Administrator overview" : "Staff workspace";
    description.textContent = user.role === "admin"
      ? "Manage the shop, team access and business performance."
      : "Keep customer orders and production jobs moving.";
    await refreshAll();
  }
}

document.querySelectorAll(".nav-link").forEach(button => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});
document.querySelectorAll("[data-go]").forEach(button => {
  button.addEventListener("click", () => switchView(button.dataset.go));
});

async function loadDashboard() {
  const data = await api("/api/dashboard");
  const cards = state.user?.role === "admin"
    ? [
      ["Sales received", money(data.sales_received), "Collected payments", "blue"],
      ["Orders", data.orders, `${data.pending_orders} awaiting full payment`, "violet"],
      ["Customers", data.customers, "In your customer book", "green"],
      ["Low stock", data.low_stock_products, "Products at reorder level", "amber"],
      ["Expenses", money(data.expenses), "Recorded business costs", "rose"],
      ["Cash after expenses", money(data.cash_surplus_before_other_costs), "Before product costs & tax", "dark"]
    ]
    : [
      ["Orders", data.orders, "All customer orders", "blue"],
      ["Open jobs", data.open_jobs, "Still moving through production", "violet"],
      ["Customers", data.customers, "In your customer book", "green"],
      ["Low stock", data.low_stock_products, "Products at reorder level", "amber"]
    ];
  $("#stats").innerHTML = cards.map(([label, value, caption, color]) => `
    <article class="stat-card stat-${color}">
      <div class="stat-top"><span>${label}</span><i></i></div>
      <strong>${value}</strong><small>${caption}</small>
    </article>`).join("");
}

async function loadCustomers() {
  state.customers = await api("/api/customers");
  const options = `<option value="">Select a customer</option>${state.customers.map(customer =>
    `<option value="${customer.id}">${escapeHtml(customer.name)} · ${escapeHtml(customer.phone)}</option>`
  ).join("")}`;
  $("#customerSelect").innerHTML = options;
  document.querySelectorAll(".customerSelect").forEach(select => { select.innerHTML = options; });
  renderCustomers();
}

function renderCustomers() {
  const query = ($("#customerSearch").value || "").trim().toLowerCase();
  const customers = state.customers.filter(customer =>
    `${customer.name} ${customer.phone} ${customer.email || ""}`.toLowerCase().includes(query)
  );
  $("#customersTable").innerHTML = tableMarkup(
    ["Customer", "Phone", "Visits", "Points", "Registered", ""],
    customers.map(customer => `<tr>
      <td><strong>${escapeHtml(customer.name)}</strong><small class="cell-sub">${escapeHtml(customer.email || "No email")}</small></td>
      <td>${escapeHtml(customer.phone)}</td><td>${customer.visits}</td><td>${customer.loyalty_points}</td>
      <td>${formatDate(customer.created_at)}</td><td><button class="table-action" data-customer="${customer.id}">Loyalty details</button></td>
    </tr>`),
    "No customers found. Add your first customer using the form."
  );
  const options = `<option value="">Select an outstanding order</option>${state.orders
    .filter(order => Number(order.total) > Number(order.paid))
    .map(order => `<option value="${order.id}">#${order.id} · ${escapeHtml(customerName(order.customer_id))} · owing ${money(order.total - order.paid)}</option>`)
    .join("")}`;
  $("#paymentOrder").innerHTML = options;
}

function customerName(id) {
  if (state.user?.role === "customer" && state.user.customer_id === id) return state.user.name;
  return state.customers.find(customer => customer.id === id)?.name || `Customer #${id}`;
}

function orderWorkAction(order) {
  const nextStep = {
    received: ["in_progress", "Start job"],
    in_progress: ["ready", "Mark ready"],
    ready: ["completed", "Complete job"]
  }[order.production_status];
  if (state.user?.role === "customer" || !nextStep) {
    return `<span class="status-pill status-${escapeHtml(order.production_status)}">${escapeHtml(order.production_status.replaceAll("_", " "))}</span>`;
  }
  return `<button class="table-action work-action" data-order-next="${nextStep[0]}" data-order-id="${order.id}">${nextStep[1]}</button>`;
}

function orderWorkStatus(order) {
  return `<span class="status-pill status-${escapeHtml(order.production_status)}">${escapeHtml(order.production_status.replaceAll("_", " "))}</span>`;
}

function shirtWorkAction(order) {
  if (["quotation_requested", "design_received"].includes(order.status)) {
    return `<div class="quote-action"><input type="number" min="0" step="0.01" aria-label="Unit price for T-shirt order ${order.id}" data-quote-price="${order.id}" placeholder="Price each"><button class="table-action" data-shirt-quote="${order.id}">Send quote</button></div>`;
  }
  const nextStep = {
    approved: ["in_production", "Start production"],
    in_production: ["ready", "Mark ready"],
    ready: ["completed", "Complete job"]
  }[order.status];
  return nextStep
    ? `<button class="table-action work-action" data-shirt-next="${nextStep[0]}" data-shirt-id="${order.id}">${nextStep[1]}</button>`
    : escapeHtml(order.status.replaceAll("_", " "));
}

async function loadOrders() {
  state.orders = await api("/api/orders");
  renderOrders();
  renderCustomers();
  $("#recentOrders").innerHTML = tableMarkup(
    ["Order", "Customer", "Job progress", "Total", "Created"],
    state.orders.slice(0, 5).map(order => `<tr>
      <td><strong>#${order.id}</strong></td><td>${escapeHtml(customerName(order.customer_id))}</td>
      <td>${orderWorkStatus(order)}</td>
      <td>${money(order.total)}</td><td>${formatDate(order.created_at)}</td>
    </tr>`),
    "Orders will appear here after you create the first sale."
  );
}

function renderOrders() {
  $("#ordersTable").innerHTML = tableMarkup(
    ["Order", "Customer", "Job progress", "Payment", "Total", "Paid", "Balance", "Print file", "Created", "Actions"],
    state.orders.map(order => `<tr>
      <td><strong>#${order.id}</strong></td><td>${escapeHtml(customerName(order.customer_id))}</td>
      <td>${orderWorkAction(order)}</td>
      <td>${escapeHtml(order.status)}</td><td>${money(order.total)}</td><td>${money(order.paid)}</td><td>${money(order.total - order.paid)}</td>
      <td>${order.has_attachment ? `<a class="table-action" href="/api/orders/${order.id}/attachment">Download</a>` : "—"}</td>
      <td>${dateTime(order.created_at)}</td>
      <td class="action-cell"><button class="table-action" data-job-history="print" data-job-id="${order.id}">Progress</button>
      <button class="table-action" data-send-progress="print" data-job-id="${order.id}">Update customer</button>
      ${Number(order.total) > Number(order.paid) ? `<button class="table-action" data-pay="${order.id}">Payment</button>` : ""}
      <button class="table-action" data-receipt="${order.id}">Receipt</button></td>
    </tr>`),
    "There are no orders yet. Create an order to start tracking sales."
  );
}

async function loadProducts() {
  state.products = await api("/api/products");
  $("#productsTable").innerHTML = tableMarkup(
    ["Product", "SKU", "On hand", "Reorder at", "Cost", "Retail", "Stock", ...(state.user?.role === "admin" ? ["Save prices"] : [])],
    state.products.map(product => `<tr>
      <td><strong>${escapeHtml(product.name)}</strong></td><td>${escapeHtml(product.sku || "—")}</td>
      <td><span class="${product.quantity <= product.reorder_level ? "stock-low" : ""}">${product.quantity}</span></td>
      <td>${product.reorder_level}</td>
      <td>${state.user?.role === "admin"
        ? `<input class="price-input" type="number" min="0" step="0.01" value="${product.cost_price}" data-product-cost="${product.id}" aria-label="Cost price for ${escapeHtml(product.name)}">`
        : money(product.cost_price)}</td>
      <td>${state.user?.role === "admin"
        ? `<input class="price-input" type="number" min="0" step="0.01" value="${product.selling_price}" data-product-selling="${product.id}" aria-label="Selling price for ${escapeHtml(product.name)}">`
        : money(product.selling_price)}</td>
      <td class="stock-actions"><button class="table-action" data-stock="${product.id}" data-change="1" aria-label="Add one to stock">＋</button>
      <button class="table-action" data-stock="${product.id}" data-change="-1" aria-label="Remove one from stock">−</button></td>
      ${state.user?.role === "admin" ? `<td><button class="table-action" data-save-product-price="${product.id}">Save</button></td>` : ""}
    </tr>`),
    "No products yet. Add your stock items using the product form."
  );
  $("#lowStock").innerHTML = state.products.filter(product => product.quantity <= product.reorder_level).length
    ? state.products.filter(product => product.quantity <= product.reorder_level).slice(0, 5).map(product => `
      <div class="compact-row"><span class="warning-icon">!</span><div><strong>${escapeHtml(product.name)}</strong><small>${product.quantity} left · alert at ${product.reorder_level}</small></div><b>${product.quantity}</b></div>
    `).join("")
    : `<div class="empty-state compact-empty">All products are above their reorder levels.</div>`;
}

async function loadMachines() {
  const machines = await api("/api/machines");
  const statusLabels = {
    in_service: "In service",
    maintenance: "Needs maintenance",
    out_of_service: "Out of service"
  };
  $("#machinesTable").innerHTML = tableMarkup(
    ["Machine", "Make / model", "Serial number", "Location", "Status", "Notes"],
    machines.map(machine => `<tr>
      <td><strong>${escapeHtml(machine.name)}</strong></td>
      <td>${escapeHtml(machine.model || "—")}</td>
      <td>${escapeHtml(machine.serial_number || "—")}</td>
      <td>${escapeHtml(machine.location || "—")}</td>
      <td><span class="status-pill status-${escapeHtml(machine.status)}">${statusLabels[machine.status] || escapeHtml(machine.status)}</span></td>
      <td>${escapeHtml(machine.notes || "—")}</td>
    </tr>`),
    "No machines have been added yet."
  );
}

async function loadServices() {
  state.services = await api("/api/services");
  $("#servicesTable").innerHTML = tableMarkup(
    ["Service", "Category", "Unit", "Unit price", ...(state.user?.role === "admin" ? [""] : [])],
    state.services.map(service => `<tr>
      <td><strong>${escapeHtml(service.name)}</strong></td><td>${escapeHtml(service.category)}</td><td>${escapeHtml(service.unit)}</td>
      <td>${state.user?.role === "admin"
        ? `<input class="price-input" type="number" min="0" step="0.01" value="${service.unit_price}" data-service-price="${service.id}" aria-label="Unit price for ${escapeHtml(service.name)}">`
        : money(service.unit_price)}</td>
      ${state.user?.role === "admin" ? `<td><button class="table-action" data-save-service-price="${service.id}">Save</button></td>` : ""}
    </tr>`),
    "No active services are configured."
  );
}

async function loadDocuments() {
  const jobs = await api("/api/documents");
  $("#documentsTable").innerHTML = tableMarkup(
    ["Job", "Customer", "File", "Type", "Status", "Uploaded", "Actions"],
    jobs.map(job => `<tr>
      <td><strong>#${job.id}</strong></td><td>${escapeHtml(job.customer_name)}</td><td>${escapeHtml(job.original_name)}</td>
      <td>${escapeHtml(job.job_type)}</td><td><span class="status-pill status-${escapeHtml(job.status)}">${escapeHtml(job.status.replaceAll("_", " "))}</span></td>
      <td>${formatDate(job.created_at)}</td><td class="action-cell">
      <button class="table-action" data-job-history="document" data-job-id="${job.id}">Progress</button>
      <button class="table-action" data-send-progress="document" data-job-id="${job.id}">Update customer</button>
      ${job.has_original_file ? `<a class="table-action" href="/api/documents/${job.id}/original">Original</a>` : ""}
      <button class="table-action" data-open-editor="${job.id}">Open editor</button>
      ${documentNextAction(job)}
      ${job.has_edited_text ? `<a class="table-action" href="/api/documents/${job.id}/download-word">Word</a>` : ""}
      </td></tr>`),
    "No document jobs yet. Upload a customer file to begin."
  );
}

async function loadAIStatus() {
  const status = await api("/api/ai/status");
  state.aiAvailable = status.available;
  const banner = $("#aiStatusBanner");
  banner.className = `ai-status-banner${status.available ? " is-ready" : ""}`;
  banner.textContent = status.available
    ? `AI is configured (${status.model}). Requested text is sent to OpenAI; AI actions apply and save automatically. After Undo, save to persist the restored version.`
    : "Real AI is not configured. Set OPENAI_API_KEY in .env or Render to enable assignment drafting and coaching.";
  $("#editorAIStatus").textContent = status.available
    ? `Using ${status.model}. Editor text is sent to OpenAI; results are saved automatically. After Undo, save to persist the restored version.`
    : "AI unavailable until OPENAI_API_KEY is configured. No demo text will be presented as an AI result.";
}

async function loadShirts() {
  const orders = await api("/api/tshirts");
  $("#shirtsTable").innerHTML = tableMarkup(
    ["Order", "Customer", "Garment", "Qty", "Unit price", "Artwork", "Status", "Created", "Progress & action"],
    orders.map(order => `<tr>
      <td><strong>#${order.id}</strong></td><td>${escapeHtml(order.customer_name)}</td>
      <td>${escapeHtml(order.colour)} / ${escapeHtml(order.size)}</td><td>${order.quantity}</td>
      <td>${money(order.unit_price)}</td><td>${order.has_design ? `<a class="table-action" href="/api/tshirts/${order.id}/design">Download</a>` : "Not received"}</td>
      <td><span class="status-pill status-${escapeHtml(order.status)}">${escapeHtml(order.status.replaceAll("_", " "))}</span></td><td>${formatDate(order.created_at)}</td>
      <td><button class="table-action" data-job-history="tshirt" data-job-id="${order.id}">Progress</button>
      <button class="table-action" data-send-progress="tshirt" data-job-id="${order.id}">Update customer</button>
      ${state.user?.role === "customer" ? "" : shirtWorkAction(order)}</td>
    </tr>`),
    "No T-shirt production orders have been created."
  );
}

async function loadExpenses() {
  const expenses = await api("/api/expenses");
  $("#expensesTable").innerHTML = tableMarkup(
    ["Expense", "Category", "Amount", "Date"],
    expenses.map(expense => `<tr><td><strong>${escapeHtml(expense.description)}</strong></td><td>${escapeHtml(expense.category)}</td><td>${money(expense.amount)}</td><td>${dateTime(expense.created_at)}</td></tr>`),
    "No expenses have been recorded."
  );
}

function reportMarkup(report) {
  return `<div class="report-metrics">
    <div><small>Sales received</small><strong>${money(report.sales_received)}</strong></div>
    <div><small>Expenses</small><strong>${money(report.expenses)}</strong></div>
    <div><small>Cash after expenses</small><strong>${money(report.cash_after_expenses)}</strong></div>
    <div><small>Outstanding</small><strong>${money(report.amount_owing)}</strong></div>
  </div><p class="report-note">${escapeHtml(report.profit_note)}</p>`;
}

async function loadDailyReport() {
  $("#dailyReport").innerHTML = reportMarkup(await api("/api/reports/daily"));
}

async function loadMonthlyReport(year, month) {
  const query = new URLSearchParams({ year, month });
  $("#monthlyReport").innerHTML = reportMarkup(await api(`/api/reports/monthly?${query}`));
}

async function loadAudit() {
  const logs = await api("/api/audit");
  $("#auditTable").innerHTML = tableMarkup(
    ["Event", "Details", "Date"],
    logs.map(log => `<tr><td><span class="audit-event">${escapeHtml(log.action)}</span></td><td>${escapeHtml(log.details || "—")}</td><td>${dateTime(log.created_at)}</td></tr>`),
    "New business activity will appear here."
  );
}

async function loadAdminUsers() {
  const users = await api("/api/admin/users");
  $("#usersTable").innerHTML = tableMarkup(
    ["Name", "Email", "Role", "Access", "Created", ""],
    users.map(user => `<tr>
      <td><strong>${escapeHtml(user.name)}</strong></td><td>${escapeHtml(user.email)}</td>
      <td>${escapeHtml(user.role)}</td><td><span class="status-pill ${user.active ? "status-paid" : ""}">${user.active ? "Active" : "Disabled"}</span></td>
      <td>${formatDate(user.created_at)}</td><td>${user.id === state.user.id ? "You" : `<button class="table-action" data-toggle-user="${user.id}" data-active="${user.active}">${user.active ? "Disable" : "Enable"}</button>`}</td>
    </tr>`),
    "No accounts are available."
  );
}

async function loadCustomerPortal() {
  const [user, services, orders, jobs, shirts] = await Promise.all([
    api("/api/auth/me"),
    api("/api/services"),
    api("/api/orders"),
    api("/api/documents"),
    api("/api/tshirts")
  ]);
  state.user = user;
  state.services = services;
  $("#portalGreeting").textContent = `Welcome, ${user.name.split(" ")[0]}`;
  $("#portalName").textContent = user.name;
  $("#portalEmail").textContent = user.email;
  $("#portalMonogram").textContent = user.name.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  $("#portalLoyalty").textContent = `${user.customer?.visits || 0} visits · ${user.customer?.discount_percent || 0}% discount`;
  $("#portalPoints").textContent = `${user.customer?.loyalty_points || 0} loyalty points`;
  const notifications = await api("/api/notifications");
  $("#notificationCount").textContent = `${notifications.length} ${notifications.length === 1 ? "update" : "updates"}`;
  $("#customerNotifications").innerHTML = updateListMarkup(notifications);
  $("#portalService").innerHTML = `<option value="">Choose a service</option>${services.map(service =>
    `<option value="${service.id}">${escapeHtml(service.name)} · ${money(service.unit_price)} / ${escapeHtml(service.unit)}</option>`
  ).join("")}`;
  $("#portalOrders").innerHTML = tableMarkup(
    ["Order", "Job progress", "Payment", "Total", "Paid", "Balance", "Print file", "Date", ""],
    orders.map(order => `<tr><td><strong>#${order.id}</strong></td><td><span class="status-pill status-${escapeHtml(order.production_status)}">${escapeHtml(order.production_status.replaceAll("_", " "))}</span></td><td>${escapeHtml(order.status)}</td><td>${money(order.total)}</td><td>${money(order.paid)}</td><td>${money(order.total - order.paid)}</td><td>${order.has_attachment ? `<a class="table-action" href="/api/orders/${order.id}/attachment">Download</a>` : "—"}</td><td>${formatDate(order.created_at)}</td><td><button class="table-action" data-job-history="print" data-job-id="${order.id}">Timeline</button></td></tr>`),
    "Your order requests will appear here."
  );
  $("#portalDocuments").innerHTML = tableMarkup(
    ["File", "Status", "Original", "Edited", "Progress"],
    jobs.map(job => `<tr><td>${escapeHtml(job.original_name)}</td><td>${escapeHtml(job.status.replaceAll("_", " "))}</td><td>${job.has_original_file ? `<a class="table-action" href="/api/documents/${job.id}/original">Download</a>` : "—"}</td><td>${job.has_edited_text ? `<a class="table-action" href="/api/documents/${job.id}/download-word">Word</a>` : "—"}</td><td><button class="table-action" data-job-history="document" data-job-id="${job.id}">Timeline</button></td></tr>`),
    "No document jobs yet."
  );
  $("#portalShirts").innerHTML = tableMarkup(
    ["Order", "Garment", "Quote", "Status", "Artwork", "Progress", ""],
    shirts.map(order => `<tr><td><strong>#${order.id}</strong></td><td>${escapeHtml(order.colour)} / ${escapeHtml(order.size)} · ${order.quantity}</td><td>${order.status === "quoted" ? money(order.unit_price * order.quantity) : order.unit_price ? money(order.unit_price * order.quantity) : "Awaiting quote"}</td><td><span class="status-pill status-${escapeHtml(order.status)}">${escapeHtml(order.status.replaceAll("_", " "))}</span></td><td>${order.has_design ? `<a class="table-action" href="/api/tshirts/${order.id}/design">Download</a>` : "—"}</td><td><button class="table-action" data-job-history="tshirt" data-job-id="${order.id}">Timeline</button></td><td>${order.status === "quoted" ? `<button class="table-action" data-approve-shirt="${order.id}">Accept quote</button>` : ""}</td></tr>`),
    "No T-shirt requests yet."
  );
}

function addOrderLine(description = "", quantity = 1, unitPrice = 0) {
  const row = document.createElement("div");
  row.className = "order-line";
  row.innerHTML = `<label>Description<input class="line-description" required maxlength="200" value="${escapeHtml(description)}" placeholder="e.g. Colour printing"></label>
    <label>Qty<input class="line-quantity" type="number" min="0.01" step="0.01" required value="${quantity}"></label>
    <label>Unit (K)<input class="line-price" type="number" min="0" step="0.01" required value="${unitPrice}"></label>
    <button class="remove-line" type="button" aria-label="Remove order item">×</button>`;
  row.querySelector(".remove-line").addEventListener("click", () => {
    if ($("#orderItems").children.length > 1) row.remove();
    else notify("An order needs at least one item.", true);
  });
  $("#orderItems").append(row);
}

$("#addOrderLine").addEventListener("click", () => addOrderLine());
addOrderLine("", 1, 0);

$("#customerForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const data = Object.fromEntries(new FormData(form));
    await api("/api/customers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    form.reset();
    showMessage("#customerMsg", "Customer registered.");
    await Promise.all([loadCustomers(), loadDashboard()]);
  } catch (error) {
    showMessage("#customerMsg", error.message, true);
  }
});

$("#customerSearch").addEventListener("input", renderCustomers);

$("#orderForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const items = [...$("#orderItems").querySelectorAll(".order-line")].map(row => ({
    description: row.querySelector(".line-description").value.trim(),
    quantity: Number(row.querySelector(".line-quantity").value),
    unit_price: Number(row.querySelector(".line-price").value)
  }));
  try {
    const result = await api("/api/orders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: Number(data.get("customer_id")), notes: data.get("notes"), items })
    });
    showMessage("#orderMsg", `Order #${result.order_id} saved · subtotal ${money(result.subtotal)} · loyalty saving ${money(result.discount)} · total ${money(result.total)}.`);
    await Promise.all([loadOrders(), loadDashboard()]);
  } catch (error) {
    showMessage("#orderMsg", error.message, true);
  }
});

async function savePayment(data) {
  const orderId = Number(data.get("order_id"));
  const result = await api(`/api/orders/${orderId}/payments`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: Number(data.get("amount")),
      method: data.get("method"),
      reference: data.get("reference") || null
    })
  });
  const updates = [loadOrders(), loadCustomers(), loadDashboard()];
  if (state.user.role === "admin") updates.push(loadAudit());
  await Promise.all(updates);
  return result;
}

$("#paymentForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const result = await savePayment(new FormData(event.currentTarget));
    showMessage("#paymentMsg", `Payment recorded. Order #${result.order_id} balance: ${money(result.balance)}.`);
    event.currentTarget.reset();
  } catch (error) {
    showMessage("#paymentMsg", error.message, true);
  }
});

$("#quickPaymentForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const result = await savePayment(new FormData(event.currentTarget));
    $("#paymentDialog").close();
    notify(`Payment recorded. Remaining balance: ${money(result.balance)}.`);
  } catch (error) {
    showMessage("#quickPaymentForm .form-message", error.message, true);
  }
});

$("#ordersTable").addEventListener("click", async event => {
  const paymentButton = event.target.closest("[data-pay]");
  const receiptButton = event.target.closest("[data-receipt]");
  const workButton = event.target.closest("[data-order-next]");
  const historyButton = event.target.closest("[data-job-history]");
  if (historyButton) {
    await showJobHistory(historyButton.dataset.jobHistory, Number(historyButton.dataset.jobId));
    return;
  }
  if (workButton) {
    try {
      const result = await api(`/api/orders/${workButton.dataset.orderId}/production-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: workButton.dataset.orderNext })
      });
      const delivery = result.production_status === "completed"
        ? ` · ${completionDelivery(result.whatsapp_status)}`
        : "";
      notify(`Order #${workButton.dataset.orderId} moved to ${workButton.dataset.orderNext.replaceAll("_", " ")}${delivery}.`);
      await loadOrders();
      await loadDashboard();
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (paymentButton) {
    const order = state.orders.find(item => item.id === Number(paymentButton.dataset.pay));
    if (!order) return;
    const form = $("#quickPaymentForm");
    form.elements.order_id.value = order.id;
    form.elements.amount.max = Number(order.total) - Number(order.paid);
    form.elements.amount.value = (Number(order.total) - Number(order.paid)).toFixed(2);
    $("#paymentDialogTitle").textContent = `Order #${order.id} · ${money(order.total - order.paid)} due`;
    $("#paymentDialog").showModal();
  }
  if (receiptButton) await printReceipt(Number(receiptButton.dataset.receipt));
});

async function printReceipt(orderId) {
  const printWindow = window.open("", "_blank", "width=720,height=800");
  if (!printWindow) {
    notify("Allow pop-ups to print a receipt.", true);
    return;
  }
  try {
    const detail = await api(`/api/orders/${orderId}`);
    const order = detail.order;
    const customer = state.customers.find(item => item.id === order.customer_id);
    const lineRows = detail.items.map(item => `<tr><td>${escapeHtml(item.description)}</td><td>${item.quantity}</td><td>${money(item.unit_price)}</td><td>${money(item.line_total)}</td></tr>`).join("");
    printWindow.document.write(`<!doctype html><html><head><title>Receipt #${order.id}</title><style>
      body{font:14px Arial,sans-serif;color:#172033;max-width:680px;margin:40px auto;padding:0 20px}header{border-bottom:2px solid #222;padding-bottom:16px;margin-bottom:20px}h1{font-size:22px;margin:0 0 6px}p{margin:5px 0;color:#586174}table{width:100%;border-collapse:collapse;margin:22px 0}th,td{text-align:left;padding:10px 6px;border-bottom:1px solid #ddd}th:last-child,td:last-child{text-align:right}.totals{margin-left:auto;width:260px}.totals div{display:flex;justify-content:space-between;padding:6px}.grand{border-top:2px solid #222;font-weight:bold;font-size:17px}.thanks{text-align:center;margin-top:35px}</style></head><body>
      <header><h1>${escapeHtml("Stationary Hub")}</h1><p>Payment receipt · Order #${order.id}</p></header>
      <p><strong>Customer:</strong> ${escapeHtml(customer?.name || `Customer #${order.customer_id}`)}</p><p><strong>Date:</strong> ${escapeHtml(dateTime(order.created_at))}</p>
      <table><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>${lineRows}</tbody></table>
      <div class="totals"><div><span>Subtotal</span><strong>${money(order.subtotal)}</strong></div><div><span>Discount</span><strong>−${money(order.discount)}</strong></div><div class="grand"><span>Total</span><strong>${money(order.total)}</strong></div><div><span>Paid</span><strong>${money(order.paid)}</strong></div><div><span>Balance</span><strong>${money(detail.balance)}</strong></div></div>
      <p class="thanks">Thank you for your business.</p><script>window.onload=()=>window.print();</script></body></html>`);
    printWindow.document.close();
  } catch (error) {
    printWindow.close();
    notify(error.message, true);
  }
}

$("#docForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const result = await api("/api/documents/upload", { method: "POST", body: new FormData(event.currentTarget) });
    showMessage("#docMsg", `Document received as job #${result.job_id}. Text extraction: ${result.status} (${result.extracted_characters} characters).`);
    event.currentTarget.reset();
    await loadDocuments();
  } catch (error) {
    showMessage("#docMsg", error.message, true);
  }
});

$("#assignmentForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const brief = values.brief.trim();
  try {
    const draft = await api("/api/documents/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: Number(values.customer_id),
        title: values.title.trim(),
        brief,
        requested_pages: values.requested_pages ? Number(values.requested_pages) : null
      })
    });
    form.reset();
    showMessage("#assignmentMsg", `Assignment job #${draft.job_id} created. Opening the AI draft workspace.`);
    await Promise.all([loadDocuments(), loadAIStatus()]);
    await openDocumentEditor(draft.job_id, {
      action: "draft",
      instruction: brief,
      autoRun: true
    });
  } catch (error) {
    showMessage("#assignmentMsg", error.message, true);
  }
});

$("#documentsTable").addEventListener("click", async event => {
  const historyButton = event.target.closest("[data-job-history]");
  const editorButton = event.target.closest("[data-open-editor]");
  const statusButton = event.target.closest("[data-document-next]");
  if (historyButton) {
    await showJobHistory(historyButton.dataset.jobHistory, Number(historyButton.dataset.jobId));
    return;
  }
  if (editorButton) {
    await openDocumentEditor(Number(editorButton.dataset.openEditor));
    return;
  }
  if (statusButton) {
    try {
      const result = await api(`/api/documents/${statusButton.dataset.documentId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: statusButton.dataset.documentNext })
      });
      const delivery = result.status === "completed" ? ` · ${completionDelivery(result.whatsapp_status)}` : "";
      notify(`Document job #${result.job_id} moved to ${result.status.replaceAll("_", " ")}${delivery}`);
      await Promise.all([loadDocuments(), loadDashboard()]);
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
});

$("#shirtForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const design = formData.get("design");
  const order = {
    customer_id: Number(formData.get("customer_id")),
    colour: formData.get("colour"),
    size: formData.get("size"),
    quantity: Number(formData.get("quantity")),
    unit_price: Number(formData.get("unit_price")),
    notes: formData.get("notes") || null
  };
  try {
    const created = await api("/api/tshirts", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order)
    });
    if (design && design.size) {
      const upload = new FormData();
      upload.set("file", design);
      await api(`/api/tshirts/${created.id}/design`, { method: "POST", body: upload });
    }
    form.reset();
    showMessage("#shirtMsg", `T-shirt order #${created.id} created${design && design.size ? " and artwork uploaded" : ""}.`);
    await loadShirts();
  } catch (error) {
    showMessage("#shirtMsg", error.message, true);
    await loadShirts();
  }
});

$("#serviceForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  values.unit_price = Number(values.unit_price);
  try {
    await api("/api/services", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
    form.reset();
    showMessage("#serviceMsg", "Service added to the active price list.");
    await loadServices();
  } catch (error) {
    showMessage("#serviceMsg", error.message, true);
  }
});

$("#servicesTable").addEventListener("click", async event => {
  const button = event.target.closest("[data-save-service-price]");
  if (!button) return;
  const serviceId = button.dataset.saveServicePrice;
  const price = Number($(`[data-service-price="${serviceId}"]`).value);
  if (!Number.isFinite(price) || price < 0) {
    notify("Enter a valid non-negative service price.", true);
    return;
  }
  button.disabled = true;
  try {
    await api(`/api/services/${serviceId}/price`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unit_price: price })
    });
    notify("Service price updated.");
    await loadServices();
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#productForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  ["quantity", "reorder_level", "cost_price", "selling_price"].forEach(key => { values[key] = Number(values[key]); });
  values.sku = values.sku || null;
  try {
    await api("/api/products", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
    form.reset();
    showMessage("#productMsg", "Product added to inventory.");
    await Promise.all([loadProducts(), loadDashboard()]);
  } catch (error) {
    showMessage("#productMsg", error.message, true);
  }
});

$("#machineForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  ["name", "model", "serial_number", "location", "notes"].forEach(key => {
    values[key] = String(values[key] || "").trim() || null;
  });
  try {
    await api("/api/machines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values)
    });
    form.reset();
    showMessage("#machineMsg", "Machine added to the shop register.");
    await loadMachines();
  } catch (error) {
    showMessage("#machineMsg", error.message, true);
  }
});

$("#progressUpdateForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!progressTarget) return;
  const target = progressTarget;
  const message = $("#progressUpdateMessage").value.trim();
  if (message.length < 3) {
    showMessage("#progressUpdateMsg", "Write at least 3 characters.", true);
    return;
  }
  const button = event.currentTarget.querySelector('button[type="submit"], button:not([type])');
  if (button) button.disabled = true;
  try {
    await api("/api/job-updates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_type: target.type, job_id: target.id, message })
    });
    $("#progressUpdateDialog").close();
    notify("Customer progress update saved.");
    await showJobHistory(target.type, target.id);
  } catch (error) {
    showMessage("#progressUpdateMsg", error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
});

$("#progressUpdateDialog").addEventListener("close", () => { progressTarget = null; });

document.addEventListener("click", event => {
  const button = event.target.closest("[data-send-progress]");
  if (button) openProgressUpdate(button.dataset.sendProgress, Number(button.dataset.jobId));
});

$("#productsTable").addEventListener("click", async event => {
  const priceButton = event.target.closest("[data-save-product-price]");
  if (priceButton) {
    const productId = priceButton.dataset.saveProductPrice;
    const costPrice = Number($(`[data-product-cost="${productId}"]`).value);
    const sellingPrice = Number($(`[data-product-selling="${productId}"]`).value);
    if (!Number.isFinite(costPrice) || costPrice < 0 || !Number.isFinite(sellingPrice) || sellingPrice < 0) {
      notify("Enter valid non-negative cost and selling prices.", true);
      return;
    }
    priceButton.disabled = true;
    try {
      await api(`/api/products/${productId}/price`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cost_price: costPrice, selling_price: sellingPrice })
      });
      notify("Product prices updated.");
      await loadProducts();
    } catch (error) {
      notify(error.message, true);
    } finally {
      priceButton.disabled = false;
    }
    return;
  }
  const button = event.target.closest("[data-stock]");
  if (!button) return;
  const formData = new FormData();
  formData.set("quantity", button.dataset.change);
  try {
    await api(`/api/products/${button.dataset.stock}/stock`, { method: "POST", body: formData });
    await Promise.all([loadProducts(), loadDashboard()]);
  } catch (error) {
    notify(error.message, true);
  }
});

$("#expenseForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  values.amount = Number(values.amount);
  try {
    await api("/api/expenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
    form.reset();
    showMessage("#expenseMsg", "Expense recorded.");
    await Promise.all([loadExpenses(), loadDashboard(), loadDailyReport()]);
  } catch (error) {
    showMessage("#expenseMsg", error.message, true);
  }
});

$("#monthForm").addEventListener("submit", async event => {
  event.preventDefault();
  const [year, month] = new FormData(event.currentTarget).get("month").split("-");
  try {
    await loadMonthlyReport(year, month);
  } catch (error) {
    notify(error.message, true);
  }
});

$("#logoutButton").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
    window.location.replace("/login");
  } catch (error) {
    notify(error.message, true);
  }
});

$("#passwordButton").addEventListener("click", () => $("#passwordDialog").showModal());
$("#passwordForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  if (values.new_password !== values.confirm_password) {
    showMessage("#passwordForm .form-message", "The new passwords do not match.", true);
    return;
  }
  try {
    await api("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: values.current_password, new_password: values.new_password })
    });
    form.reset();
    $("#passwordDialog").close();
    window.location.replace("/login?password=changed");
  } catch (error) {
    showMessage("#passwordForm .form-message", error.message, true);
  }
});

$("#staffForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    form.reset();
    showMessage("#staffMsg", "Staff account created.");
    await loadAdminUsers();
  } catch (error) {
    showMessage("#staffMsg", error.message, true);
  }
});

$("#usersTable").addEventListener("click", async event => {
  const button = event.target.closest("[data-toggle-user]");
  if (!button) return;
  try {
    await api(`/api/admin/users/${button.dataset.toggleUser}/active`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: button.dataset.active !== "true" })
    });
    await loadAdminUsers();
  } catch (error) {
    notify(error.message, true);
  }
});

$("#portalOrderForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const printFile = values.get("file");
  let orderId = null;
  try {
    const result = await api("/api/portal/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ service_id: Number(values.get("service_id")), quantity: Number(values.get("quantity")) }],
        notes: values.get("notes") || null
      })
    });
    orderId = result.order_id;
    if (printFile && printFile.size) {
      const upload = new FormData();
      upload.set("file", printFile);
      await api(`/api/orders/${orderId}/attachment`, { method: "POST", body: upload });
    }
    form.reset();
    showMessage("#portalOrderMsg", `Request #${orderId} submitted. Estimated total: ${money(result.total)}.`);
    await loadCustomerPortal();
  } catch (error) {
    const message = orderId
      ? `Request #${orderId} was saved, but the print file could not be uploaded: ${error.message}`
      : error.message;
    showMessage("#portalOrderMsg", message, true);
    if (orderId) {
      await loadCustomerPortal().catch(refreshError => notify(refreshError.message, true));
    }
  }
});

$("#portalDocForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/documents/upload", { method: "POST", body: new FormData(form) });
    showMessage("#portalDocMsg", `Document received as job #${result.job_id}. Status: ${result.status}.`);
    form.reset();
    await loadCustomerPortal();
  } catch (error) {
    showMessage("#portalDocMsg", error.message, true);
  }
});

$("#portalShirtForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const design = formData.get("design");
  try {
    const created = await api("/api/tshirts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: state.user.customer_id,
        colour: formData.get("colour"),
        size: formData.get("size"),
        quantity: Number(formData.get("quantity")),
        unit_price: 0,
        notes: formData.get("notes") || null
      })
    });
    if (design && design.size) {
      const upload = new FormData();
      upload.set("file", design);
      await api(`/api/tshirts/${created.id}/design`, { method: "POST", body: upload });
    }
    form.reset();
    showMessage("#portalShirtMsg", `T-shirt quotation request #${created.id} submitted. The shop will confirm pricing.`);
    await loadCustomerPortal();
  } catch (error) {
    showMessage("#portalShirtMsg", error.message, true);
    await loadCustomerPortal();
  }
});

$("#shirtsTable").addEventListener("click", async event => {
  const quoteButton = event.target.closest("[data-shirt-quote]");
  const workButton = event.target.closest("[data-shirt-next]");
  const historyButton = event.target.closest("[data-job-history]");
  if (historyButton) {
    await showJobHistory(historyButton.dataset.jobHistory, Number(historyButton.dataset.jobId));
    return;
  }
  if (quoteButton) {
    const orderId = quoteButton.dataset.shirtQuote;
    const priceValue = $(`[data-quote-price="${orderId}"]`).value.trim();
    const price = Number(priceValue);
    if (!priceValue || !Number.isFinite(price) || price < 0) {
      notify("Enter a valid unit price before sending the quote.", true);
      return;
    }
    try {
      await api(`/api/tshirts/${orderId}/quote`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unit_price: price })
      });
      notify(`Quote sent for T-shirt order #${orderId}.`);
      await loadShirts();
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (workButton) {
    try {
      const result = await api(`/api/tshirts/${workButton.dataset.shirtId}/production-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: workButton.dataset.shirtNext })
      });
      const delivery = result.status === "completed"
        ? ` · ${completionDelivery(result.whatsapp_status)}`
        : "";
      notify(`T-shirt order #${workButton.dataset.shirtId} moved to ${workButton.dataset.shirtNext.replaceAll("_", " ")}${delivery}`);
      await loadShirts();
    } catch (error) {
      notify(error.message, true);
    }
  }
});

$("#portalShirts").addEventListener("click", async event => {
  const button = event.target.closest("[data-approve-shirt]");
  const historyButton = event.target.closest("[data-job-history]");
  if (historyButton) {
    await showJobHistory(historyButton.dataset.jobHistory, Number(historyButton.dataset.jobId));
    return;
  }
  if (!button) return;
  try {
    await api(`/api/tshirts/${button.dataset.approveShirt}/approve`, { method: "POST" });
    notify("Quote accepted. The shop can now start production.");
    await loadCustomerPortal();
  } catch (error) {
    notify(error.message, true);
  }
});

$("#portalOrders").addEventListener("click", event => {
  const button = event.target.closest("[data-job-history]");
  if (button) showJobHistory(button.dataset.jobHistory, Number(button.dataset.jobId));
});

$("#portalDocuments").addEventListener("click", event => {
  const button = event.target.closest("[data-job-history]");
  if (button) showJobHistory(button.dataset.jobHistory, Number(button.dataset.jobId));
});

$("#documentEditorText").addEventListener("input", event => {
  const current = event.currentTarget.value;
  if (current !== previousEditorText) {
    editorUndo.push(previousEditorText);
    if (editorUndo.length > 100) editorUndo.shift();
    editorRedo = [];
    previousEditorText = current;
  }
  updateEditorWordCount();
});

$("#editorFont").addEventListener("change", event => {
  $("#documentEditorText").style.fontFamily = event.currentTarget.value;
});

$("#editorFontSize").addEventListener("change", event => {
  $("#documentEditorText").style.fontSize = `${event.currentTarget.value}pt`;
});

$("#editorUndo").addEventListener("click", () => {
  if (!editorUndo.length) return;
  editorRedo.push($("#documentEditorText").value);
  $("#documentEditorText").value = editorUndo.pop();
  previousEditorText = $("#documentEditorText").value;
  updateEditorWordCount();
  showMessage("#editorMessage", "Undo applied in the editor. Click Save changes to persist this version.");
});

$("#editorRedo").addEventListener("click", () => {
  if (!editorRedo.length) return;
  editorUndo.push($("#documentEditorText").value);
  $("#documentEditorText").value = editorRedo.pop();
  previousEditorText = $("#documentEditorText").value;
  updateEditorWordCount();
  showMessage("#editorMessage", "Redo applied in the editor. Click Save changes to persist this version.");
});

$("#editorSave").addEventListener("click", async () => {
  const text = $("#documentEditorText").value;
  if (!text.trim()) {
    showMessage("#editorMessage", "Add document text before saving.", true);
    return;
  }
  try {
    await api(`/api/documents/${state.documentId}/editor`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    showMessage("#editorMessage", "Changes saved. The customer can download the edited Word document.");
    await Promise.all([loadDocuments(), loadCustomerPortalIfCustomer()]);
  } catch (error) {
    showMessage("#editorMessage", error.message, true);
  }
});

async function loadCustomerPortalIfCustomer() {
  if (state.user?.role === "customer") await loadCustomerPortal();
}

async function runDocumentAI() {
  const action = $("#editorAIAction").value;
  const text = $("#documentEditorText").value;
  const instruction = $("#editorAIInstruction").value.trim();
  if (!instruction) {
    showMessage("#editorMessage", "Enter an assignment brief or a specific writing request.", true);
    return;
  }
  if (action === "coach" && !text.trim()) {
    showMessage("#editorMessage", "Add assignment text before asking the AI coach to improve it.", true);
    return;
  }
  const button = $("#editorAIApply");
  button.disabled = true;
  try {
    const result = await api(`/api/documents/${state.documentId}/ai-assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, text, instruction })
    });
    editorUndo.push(text);
    if (editorUndo.length > 100) editorUndo.shift();
    editorRedo = [];
    $("#documentEditorText").value = result.edited_text;
    previousEditorText = result.edited_text;
    updateEditorWordCount();
    showMessage(
      "#editorMessage",
      `${action === "draft" ? "Assignment draft created" : "Writing improvements applied"} and saved. Use Undo to restore the previous text; verify facts and citations.`
    );
    loadDocuments().catch(error => notify(`AI changes were saved, but the job list could not refresh: ${error.message}`, true));
  } catch (error) {
    showMessage("#editorMessage", error.message, true);
  } finally {
    button.disabled = false;
  }
}

$("#editorAIApply").addEventListener("click", runDocumentAI);

$("#editorDownloadWord").addEventListener("click", () => {
  window.location.href = `/api/documents/${state.documentId}/download-word`;
});

$("#refreshPortal").addEventListener("click", () => loadCustomerPortal().catch(error => notify(error.message, true)));
$("#refreshUsers").addEventListener("click", () => loadAdminUsers().catch(error => notify(error.message, true)));

$("#customerSearch").value = "";
$("#refreshAll").addEventListener("click", refreshAll);
$("#refreshOrders").addEventListener("click", () => loadOrders().catch(error => notify(error.message, true)));
$("#refreshProducts").addEventListener("click", () => loadProducts().catch(error => notify(error.message, true)));
$("#refreshMachines").addEventListener("click", () => loadMachines().catch(error => notify(error.message, true)));
$("#refreshServices").addEventListener("click", () => loadServices().catch(error => notify(error.message, true)));
$("#refreshDocuments").addEventListener("click", () => loadDocuments().catch(error => notify(error.message, true)));
$("#refreshShirts").addEventListener("click", () => loadShirts().catch(error => notify(error.message, true)));
$("#refreshExpenses").addEventListener("click", () => loadExpenses().catch(error => notify(error.message, true)));
$("#refreshDaily").addEventListener("click", () => loadDailyReport().catch(error => notify(error.message, true)));
$("#refreshAudit").addEventListener("click", () => loadAudit().catch(error => notify(error.message, true)));

$("#customersTable").addEventListener("click", async event => {
  const button = event.target.closest("[data-customer]");
  if (!button) return;
  try {
    const detail = await api(`/api/customers/${button.dataset.customer}`);
    const visits = detail.customer.visits;
    const nextMilestone = [3, 5, 8, 12].find(target => visits < target);
    const remaining = nextMilestone ? nextMilestone - visits : 0;
    $("#previewTitle").textContent = `${detail.customer.name} · loyalty`;
    $("#previewText").textContent = [
      `Phone: ${detail.customer.phone}`,
      `Completed visits: ${visits}`,
      `Current discount: ${detail.discount_percent}%`,
      `Loyalty points: ${detail.customer.loyalty_points}`,
      nextMilestone ? `${remaining} more completed visit${remaining === 1 ? "" : "s"} to the next discount tier (${nextMilestone} visits).` : "Top visit discount tier reached."
    ].join("\n");
    $("#downloadEdited").hidden = true;
    $("#previewDialog").showModal();
  } catch (error) {
    notify(error.message, true);
  }
});

$("#previewDialog").addEventListener("close", () => { $("#downloadEdited").hidden = false; });

async function refreshAll() {
  if (state.user?.role === "customer") {
    await loadCustomerPortal();
    return;
  }
  const common = [loadDashboard(), loadCustomers(), loadOrders(), loadProducts(), loadMachines(), loadServices(), loadDocuments(), loadShirts(), loadAIStatus()];
  if (state.user?.role === "admin") {
    common.push(loadExpenses(), loadDailyReport(), loadAudit(), loadAdminUsers());
    const now = new Date();
    common.push(loadMonthlyReport(now.getFullYear(), now.getMonth() + 1));
  }
  const results = await Promise.allSettled(common);
  const failures = results.filter(result => result.status === "rejected");
  if (failures.length) notify(`Some data could not be refreshed: ${failures.map(result => result.reason.message).join("; ")}`, true);
}

const now = new Date();
$("#monthForm").elements.month.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
api("/api/auth/me")
  .then(enterWorkspace)
  .catch(() => window.location.replace("/login"));
