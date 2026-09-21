const { spawn } = require("child_process");
const http = require("http");

async function main() {
    const serverProcess = spawn("node", ["dist/index.js"], {
        env: { ...process.env, PORT: "3999" },
        stdio: ["ignore", "pipe", "pipe"],
    });

    serverProcess.stderr.on("data", (data) => {
        // console.error("[server err]", data.toString().trim());
    });

    await new Promise((r) => setTimeout(r, 1500));

    function callMcp(toolName, args = {}) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                jsonrpc: "2.0",
                id: Math.floor(Math.random() * 10000),
                method: "tools/call",
                params: {
                    name: toolName,
                    arguments: args,
                },
            });

            const req = http.request(
                {
                    hostname: "localhost",
                    port: 3999,
                    path: "/mcp",
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json, text/event-stream",
                    },
                },
                (res) => {
                    let data = "";
                    res.on("data", (chunk) => (data += chunk));
                    res.on("end", () => {
                        resolve(data);
                    });
                }
            );

            req.on("error", reject);
            req.write(body);
            req.end();
        });
    }

    function getAdminUsage(query = "") {
        return new Promise((resolve, reject) => {
            const req = http.request(
                {
                    hostname: "localhost",
                    port: 3999,
                    path: "/admin/usage" + query,
                    method: "GET",
                    headers: {
                        "Accept": "application/json",
                    },
                },
                (res) => {
                    let data = "";
                    res.on("data", (chunk) => (data += chunk));
                    res.on("end", () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            resolve(data);
                        }
                    });
                }
            );

            req.on("error", reject);
            req.end();
        });
    }

    try {
        console.log("Making 5 tool calls...");
        await callMcp("health_check", { url: "https://httpbin.org/status/200" });
        await callMcp("record_observation", { metric_name: "test.latency", value: 120 });
        await callMcp("record_observation", { metric_name: "test.latency", value: 125 });
        await callMcp("get_circuit_state", { tool_name: "payment_api" });
        await callMcp("validate_tool_response", { data: { status: "ok" } });

        console.log("\n==========================================");
        console.log("GET /admin/usage (all tenants)");
        console.log("==========================================");
        const usageAll = await getAdminUsage();
        console.log(JSON.stringify(usageAll, null, 2));

        console.log("\n==========================================");
        console.log("GET /admin/usage?tenant_id=default-tenant");
        console.log("==========================================");
        const usageTenant = await getAdminUsage("?tenant_id=default-tenant");
        console.log(JSON.stringify(usageTenant, null, 2));
    } finally {
        serverProcess.kill("SIGTERM");
    }
}

main().catch(console.error);
