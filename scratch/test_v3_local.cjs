const { spawn } = require("node:child_process");

const server = spawn("node", ["dist/index.js"], {
    env: {
        ...process.env,
        PORT: "3000",
        RATE_LIMIT_MAX: "10000",
        AGENTGUARD_API_KEY: "cb3b156b8a0d801aa4fb8bee5207ee5befc5dfeb2de84eef82901bf7417f310c",
    },
    stdio: ["ignore", "pipe", "pipe"],
});

server.stdout.on("data", (data) => console.log(`[server] ${data.toString().trim()}`));
server.stderr.on("data", (data) => console.error(`[server err] ${data.toString().trim()}`));

setTimeout(() => {
    console.log("Starting agentguard_v3_test.py test run against http://localhost:3000 ...");

    const tester = spawn("python3", ["/home/sreejith/Downloads/agentguard_v3_test.py"], {
        env: {
            ...process.env,
            AGENTGUARD_URL: "http://localhost:3000",
            AGENTGUARD_API_KEY: "cb3b156b8a0d801aa4fb8bee5207ee5befc5dfeb2de84eef82901bf7417f310c",
        },
        stdio: "inherit",
    });

    tester.on("exit", (code) => {
        console.log(`\nTest suite finished with code ${code}`);
        server.kill("SIGTERM");
        process.exit(code || 0);
    });
}, 1500);
