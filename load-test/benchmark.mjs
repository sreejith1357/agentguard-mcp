import autocannon from 'autocannon';

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const API_KEY = process.env.AGENTGUARD_API_KEY || '';

const authHeader = API_KEY 
  ? { Authorization: `Bearer ${API_KEY}` }
  : {};

const commonHeaders = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  ...authHeader
};

// Test 1: health endpoint (GET, no auth)
const healthTest = await autocannon({
  url: `${BASE_URL}/health`,
  connections: 10,
  duration: 10,
  title: 'GET /health'
});

// Test 2: record_observation (SQLite write under load)
const writeTest = await autocannon({
  url: `${BASE_URL}/mcp`,
  method: 'POST',
  headers: commonHeaders,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'record_observation',
      arguments: { metric_name: 'loadtest.metric', value: 100 }
    }
  }),
  connections: 10,
  duration: 10,
  title: 'record_observation (SQLite write)'
});

// Test 3: get_learned_baseline (SQLite read under load)
const readTest = await autocannon({
  url: `${BASE_URL}/mcp`,
  method: 'POST',
  headers: commonHeaders,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'get_learned_baseline',
      arguments: { metric_name: 'loadtest.metric' }
    }
  }),
  connections: 10,
  duration: 10,
  title: 'get_learned_baseline (SQLite read)'
});

// Test 4: detect_anomaly (computation under load)
const computeTest = await autocannon({
  url: `${BASE_URL}/mcp`,
  method: 'POST',
  headers: commonHeaders,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'detect_anomaly',
      arguments: {
        value: 150,
        baseline: [100,105,98,102,99,103,101,97,104,100],
        metric_name: 'loadtest.anomaly'
      }
    }
  }),
  connections: 10,
  duration: 10,
  title: 'detect_anomaly (EMA computation)'
});

function printResult(result) {
  console.log(`\n=== ${result.title} ===`);
  console.log(`Connections: ${result.connections}`);
  console.log(`Duration: ${result.duration}s`);
  console.log(`Requests/sec: ${result.requests.mean.toFixed(0)}`);
  console.log(`Latency p50: ${result.latency.p50}ms`);
  console.log(`Latency p95: ${result.latency.p95}ms`);
  console.log(`Latency p99: ${result.latency.p99}ms`);
  console.log(`Errors: ${result.errors}`);
  console.log(`Timeouts: ${result.timeouts}`);
  console.log(`Total requests: ${result.requests.total}`);
}

printResult(healthTest);
printResult(writeTest);
printResult(readTest);
printResult(computeTest);

console.log('\n=== System ===');
console.log(`Node.js: ${process.version}`);
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log(`SQLite WAL mode: enabled`);
