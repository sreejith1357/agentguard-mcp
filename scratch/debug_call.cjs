const { spawn, execSync } = require("node:child_process");

const server = spawn("node", ["dist/index.js"], {
    env: { ...process.env, PORT: "3001", RATE_LIMIT_MAX: "10000", AGENTGUARD_API_KEY: "cb3b156b8a0d801aa4fb8bee5207ee5befc5dfeb2de84eef82901bf7417f310c" },
    stdio: "inherit",
});

setTimeout(() => {
    try {
        const py = spawn("python3", ["-c", `
import requests, json

url = "http://localhost:3001/mcp"
token = "cb3b156b8a0d801aa4fb8bee5207ee5befc5dfeb2de84eef82901bf7417f310c"
body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "get_circuit_state", "arguments": {"tool_name": "payment_api"}}}
r = requests.post(url, json=body, headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": f"Bearer {token}"}, timeout=10)
print("--- RAW SPLITLINES ---")
for i, line in enumerate(r.text.splitlines()):
    print(f"Line {i}: {repr(line)}")
`], { stdio: "inherit" });

        py.on("exit", () => {
            server.kill();
            process.exit(0);
        });
    } catch (e) {
        server.kill();
        process.exit(1);
    }
}, 1000);
