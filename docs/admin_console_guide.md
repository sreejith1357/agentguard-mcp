# AgentGuard MCP Admin Console — Master User Guide & Tutorial

Welcome to your complete masterclass for the **AgentGuard MCP Admin Console (v3.1.0 Enterprise)**! 

Whether you are managing local test agents or operating a multi-tenant SaaS control plane in production, this guide breaks down **every single tab, form, button, metric, badge, and workflow** in plain, simple English.

---

## 1. How to Access & Unlock the Admin Console

### Opening the Console
Open your web browser and navigate to:
```
http://localhost:3000/admin
```
*(If running on a remote server, replace `localhost:3000` with your server domain or IP address, e.g. `http://192.168.1.50:3000/admin`).*

### The Admin Lock Screen (Authentication Modal)
When you open the page for the first time, you will see a dark popup window titled **🛡️ Admin Authentication Required**.

* **Master Admin Key Input**: Paste your `AGENTGUARD_ADMIN_KEY` (the 64-character secret token from your `.env` file).
* **Unlock Button (`Unlock Admin Console`)**: Saves the key securely in your browser's session memory (`sessionStorage`) and unlocks all dashboard features.
* **Security Note**: The key is stored **only in your browser's current tab session**. Closing the tab or clicking `🔒 Lock` immediately wipes the key from memory.

---

## 2. Top Header Bar & Global Controls

Located at the very top of the screen, the header bar allows you to connect to the server and manage your admin session.

| UI Element | Type | Purpose & How to Use |
| :--- | :--- | :--- |
| **Console Title** | Header Text | Shows `AgentGuard MCP Admin Console v3.1.0 Enterprise`. |
| **Host Input** | Text Box | Shows the backend server URL (defaults to `http://localhost:3000`). If managing a remote deployment, enter its address here. |
| **Key Input** | Password Field | Displays `••••••••` representing your current `AGENTGUARD_ADMIN_KEY`. You can edit this field at any time to switch admin keys. |
| **`● Live` Indicator** | Status Badge | Flashes green when the dashboard is successfully receiving real-time data from the server. |
| **`🔄 Sync` Button** | Action Button | Manually triggers an immediate data refresh from all backend database tables without waiting for the auto-refresh cycle. |
| **`🔒 Lock` Button** | Action Button | Immediately logs you out by wiping the saved admin key from browser memory and restoring the lock modal. Use this when stepping away from your computer. |

---

## 3. The 4 Top Metric Cards (Overview Dashboard)

Directly beneath the header bar, four metric cards give you an instant heartbeat of system health:

### 1. `TOTAL TOOL CALLS`
* **What it displays**: The total number of MCP tool executions processed during the current calendar month.
* **Why it matters**: Tells you how heavily your AI agents are using tools (validations, anomaly checks, circuit checks).

### 2. `REGISTERED TENANTS`
* **What it displays**: The count of distinct companies/customers registered in SQLite.
* **Why it matters**: Shows how many clients or teams are currently using your platform.

### 3. `TRACKED CIRCUITS`
* **What it displays**: The total number of active Circuit Breakers monitored by AgentGuard.
* **Why it matters**: Each external API or tool used by your agents has a dedicated circuit breaker to stop cascading failures.

### 4. `AVG LATENCY`
* **What it displays**: The average database response time (typically `< 10ms` thanks to SQLite WAL mode).
* **Why it matters**: Verifies that AgentGuard's governance layer adds zero noticeable delay to your agent's execution loop.

---

## 4. Deep Dive: All 6 Navigation Tabs

Below the top cards is the main navigation bar containing 6 dedicated tabs:

---

### Tab 1: 📊 Usage Analytics

**Purpose**: Visualizes which MCP tools are called most frequently by your AI agents.

#### Components:
* **Tool Invocation Frequency Chart**: Displays horizontal progress bars for each registered tool (e.g. `log_checkpoint`, `detect_anomaly`, `validate_tool_response`, `circuit_breaker_check`).
* **Invocation Counters**: Shows exact call counts alongside each tool bar.
* **How to use it**: Use this tab to identify runaway agents. If `log_checkpoint` spikes unexpectedly, an agent might be trapped in a repetitive tool loop!

---

### Tab 2: 🏢 Tenants & Subscriptions

**Purpose**: Manage customer accounts, assign billing plans, set rate limits, and suspend/delete tenants.

#### A. "Register New Tenant" Form
Use this form to onboard a new company, project, or developer:

1. **Tenant ID (Slug)**: Unique identifier (lowercase, no spaces). E.g. `acme-corp` or `dev-team-alpha`.
2. **Company / Team Name**: Human-readable name. E.g. `Acme Corporation`.
3. **Contact Email**: Customer's billing or admin email address. E.g. `admin@acmecorp.com`.
4. **Subscription Plan**: Select a tier:
   * **Free**: 1,000 calls / month
   * **Starter**: 50,000 calls / month
   * **Pro**: 500,000 calls / month
   * **Team**: 5,000,000 calls / month
5. **Internal Notes**: Free-form text box for order IDs, payment dates, or custom terms (e.g. *Lemon Squeezy Order #8821 · Paid Annually*).
6. **`➕ Create Tenant` Button**: Click to create the tenant in SQLite.

#### B. Registered Tenants Table

| Table Column | Description |
| :--- | :--- |
| **Tenant ID** | The unique slug identifier. |
| **Company / Name** | Name of the tenant. |
| **Email** | Contact email address. |
| **Plan** | Badge showing `FREE`, `STARTER`, `PRO`, or `TEAM`. |
| **Quota Usage** | A color-coded progress bar showing monthly usage vs plan quota. |
| **Status** | Green `ACTIVE` badge or yellow `SUSPENDED` badge. |
| **Notes** | Snippet of saved internal notes. Click to view or edit. |
| **Actions** | Action buttons (see below). |

#### Action Buttons in Tenants Table:
* **`📝` (Edit Notes)**: Opens a popup window to edit internal customer notes at any time.
* **`⏸️` / `▶️` (Suspend / Activate)**: 
  * Clicking `⏸️` **suspends** the tenant immediately. All API keys associated with this tenant will instantly return `403 Forbidden` errors to the agent!
  * Clicking `▶️` **reactivates** a suspended tenant.
* **`🗑️` (Delete)**: Permanently deletes the tenant and revokes all their API keys.

---

### Tab 3: 🔑 API Keys Management

**Purpose**: Issue secure API authentication keys for tenants and revoke old keys.

#### A. "Generate Live API Key" Form
1. **Assign to Tenant**: Select which registered tenant owns this key from the drop-down list.
2. **Key Description**: Give the key a clear label (e.g. `Production Customer Service Agent` or `Staging Bot`).
3. **`🔑 Generate Key` Button**: Generates a cryptographically strong 256-bit API key.

#### B. The New Key Alert Box (CRITICAL!)
When you generate a new key, a bright green box appears at the top of the console showing two critical pieces of information:

1. **Raw API Key**: E.g., `ag_live_a1b2c3d4e5f6...`
   * **Important**: This key is shown **ONLY ONCE**. Copy it immediately!
2. **Bearer Token Format**: E.g., `Bearer ag_live_a1b2c3d4e5f6...`
   * Contains a handy `Copy Bearer` button so you can copy the exact header format needed in HTTP/MCP clients.

#### C. Active API Keys Table

| Table Column | Description |
| :--- | :--- |
| **Prefix** | The safe public identifier of the key (e.g. `ag_live_a1b2...`). The secret portion is hidden. |
| **Name** | The description label you assigned to the key. |
| **Tenant ID** | The tenant who owns this key. |
| **Created** | Date and time the key was generated. |
| **Last Used** | Timestamp of the key's last successful API request (or `Never`). |
| **Action (`🚫 Revoke`)** | Immediately invalidates the key. Any agent using this key will be blocked instantly. |

---

### Tab 4: ⚡ Circuit Breakers Status Grid

**Purpose**: Monitor external tool failures and manually reset tripped circuits.

#### Understanding Circuit Breaker States:

* **`CLOSED` (Green Badge)**: Normal state. All tool calls pass through without interference.
* **`OPEN` (Red Badge)**: **TRIPPED STATE!** The target tool or API failed repeatedly (5+ errors). AgentGuard blocks all calls to this tool automatically to prevent budget drain and rate limit bans.
* **`HALF_OPEN` (Yellow Badge)**: Testing recovery. AgentGuard allows 1 test call through to see if the target service has recovered.

#### Controls in Circuit Grid:
* **`⚡ Reset Circuit` Button**: If a circuit is `OPEN` (red) or `HALF_OPEN` (yellow), clicking this button manually forces the circuit back to `CLOSED` (green), allowing calls to resume immediately.

---

### Tab 5: 🔔 Webhooks Management

**Purpose**: Receive real-time push notifications in your external systems (Slack, Discord, PagerDuty, or backend API) whenever security events occur.

#### A. "Subscribe New Webhook" Form
1. **Tenant**: Select the tenant receiving webhooks (or `default-tenant`).
2. **Webhook URL**: Your HTTPS endpoint that will receive POST payloads (e.g. `https://api.yourdomain.com/webhooks`).
3. **Events to Subscribe**: Check the event types you want to monitor:
   * `circuit.tripped`: Fires whenever an agent tool fails 5 times and trips a circuit.
   * `anomaly.detected`: Fires when unexpected tool parameter formats or prompt injection signatures are flagged.
   * `quota.warning`: Fires when a tenant reaches 80% or 100% of their monthly request quota.
4. **`🔔 Add Webhook` Button**: Registers the endpoint.

#### B. Active Webhooks Table
Shows all registered webhooks, their tenant assignment, subscribed event badges, and a `🗑️ Delete` button to unregister them.

---

### Tab 6: 🛡️ Security Audit Trail

**Purpose**: An immutable, append-only security log recording every administrative action performed in the system.

#### Audit Trail Table Columns:

| Column | Description |
| :--- | :--- |
| **Timestamp** | ISO-8601 precise time of the action (e.g. `2026-09-27T15:30:00.000Z`). |
| **Action** | Action badge (e.g. `TENANT_CREATED`, `TENANT_SUSPENDED`, `KEY_GENERATED`, `KEY_REVOKED`, `CIRCUIT_RESET`). |
| **Tenant ID** | Target tenant slug affected by the action. |
| **Details** | Technical breakdown of what changed (e.g. `Plan updated to PRO`, `Key ag_live_a1b2 revoked`). |
| **IP Address** | IP address of the admin who initiated the command. |

#### Filtering Audit Logs:
Use the **Filter audit logs...** search bar at the top right of the table to filter logs instantly by tenant ID, action type, or IP address.

---

## 5. Step-by-Step Practical Operator Workflows

### Workflow 1: Onboarding a New Paying Client (Step-by-Step)

1. Open the Admin Console at `http://localhost:3000/admin`.
2. Click the **🏢 Tenants & Subscriptions** tab.
3. In the **Register New Tenant** form:
   * Tenant ID: `globex-corp`
   * Company Name: `Globex Corporation`
   * Contact Email: `billing@globex.com`
   * Subscription Plan: Select `Pro (500,000 calls/mo)`
   * Internal Notes: `Stripe sub_1N89x2 · Enterprise Plan`
   * Click **`➕ Create Tenant`**.
4. Switch to the **🔑 API Keys** tab.
5. In the **Generate Live API Key** form:
   * Assign to Tenant: Select `globex-corp`.
   * Description: `Globex Production MCP Key`.
   * Click **`🔑 Generate Key`**.
6. The green key box will pop up. Click **`Copy Bearer`**.
7. Deliver the Bearer string (e.g. `Bearer ag_live_...`) to Globex Corporation for their agent config.

---

### Workflow 2: Handling an Emergency Tripped Circuit

1. You receive an alert or notice that an agent tool is failing.
2. Open the Admin Console and click the **⚡ Circuit Breakers** tab.
3. Locate the card for the failing service (marked with a red **`OPEN`** badge).
4. Investigate the underlying external API issue.
5. Once the external API is fixed, click the green **`⚡ Reset Circuit`** button on the circuit card.
6. The badge changes to green **`CLOSED`**, and your agents immediately resume processing requests!

---

### Workflow 3: Suspending an Unpaid Account

1. Open the **🏢 Tenants & Subscriptions** tab.
2. Type the company name in the **Filter tenants...** search box.
3. Click the yellow **`⏸️` (Suspend)** button in the Actions column.
4. The status badge immediately changes to **`SUSPENDED`**. All API requests from that client will now be blocked automatically.

---

## 6. Summary Checklist for Administrators

* ✅ **Keep your `AGENTGUARD_ADMIN_KEY` secret**: Never hardcode it into client software.
* ✅ **Issue tenant-specific API keys**: Never share the master admin key with customers.
* ✅ **Always click `🔒 Lock` when leaving your desk**: Prevents unauthorized modifications to your server setup.
* ✅ **Check the Audit Trail regularly**: Ensure all administrative actions align with expected operations.
