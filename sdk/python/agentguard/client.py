import httpx
from typing import Any, Dict, List, Optional, Union

class AgentGuardError(Exception):
    """Raised when AgentGuard MCP API returns an error."""
    pass

class AgentGuardClient:
    """
    Python Client SDK for AgentGuard MCP server endpoints.
    Provides synchronous methods to guard agent tool execution, check circuits,
    validate outputs, record baselines, and trace root-cause failures.
    """

    def __init__(self, endpoint: str = "http://localhost:3000", api_key: Optional[str] = None, timeout: float = 10.0):
        self.endpoint = endpoint.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.headers = {"Content-Type": "application/json"}
        if api_key:
            self.headers["Authorization"] = f"Bearer {api_key}"

    def _call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.endpoint}/mcp"
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            }
        }

        try:
            response = httpx.post(url, json=payload, headers=self.headers, timeout=self.timeout)
            if response.status_code == 429:
                err_data = response.json()
                raise AgentGuardError(f"Rate limit / Quota exceeded: {err_data.get('message')}")

            response.raise_for_status()
            data = response.json()

            if "error" in data:
                raise AgentGuardError(f"MCP Error: {data['error']}")

            result = data.get("result", {})
            content = result.get("content", [])
            if content and isinstance(content, list) and "text" in content[0]:
                import json
                try:
                    return json.loads(content[0]["text"])
                except Exception:
                    return {"raw": content[0]["text"]}

            return result
        except httpx.HTTPError as e:
            raise AgentGuardError(f"HTTP request failed: {str(e)}") from e

    def health_check(self, target_url: str = "http://localhost:3000") -> Dict[str, Any]:
        """Perform pre-flight health check on a target tool endpoint."""
        return self._call_tool("health_check", {"target_url": target_url})

    def get_circuit_state(self, tool_name: str) -> Dict[str, Any]:
        """Check the state of a circuit breaker before executing a tool call."""
        return self._call_tool("get_circuit_state", {"tool_name": tool_name})

    def report_tool_result(
        self,
        tool_name: str,
        success: bool,
        error_message: Optional[str] = None,
        response_time_ms: Optional[float] = None
    ) -> Dict[str, Any]:
        """Report tool execution outcome to update the circuit breaker state."""
        args: Dict[str, Any] = {"tool_name": tool_name, "success": success}
        if error_message:
            args["error_message"] = error_message
        if response_time_ms is not None:
            args["response_time_ms"] = response_time_ms
        return self._call_tool("report_tool_result", args)

    def detect_anomaly(
        self,
        value: Union[float, int, str],
        metric_name: str,
        baseline: Optional[List[Any]] = None,
        sensitivity: str = "medium"
    ) -> Dict[str, Any]:
        """Check observed value against manual or learned adaptive baseline for anomalies."""
        args: Dict[str, Any] = {
            "value": value,
            "metric_name": metric_name,
            "sensitivity": sensitivity
        }
        if baseline is not None:
            args["baseline"] = baseline
        return self._call_tool("detect_anomaly", args)

    def record_observation(self, metric_name: str, value: float) -> Dict[str, Any]:
        """Stream numeric metric observation into the adaptive baseline engine."""
        return self._call_tool("record_observation", {"metric_name": metric_name, "value": value})

    def log_checkpoint(
        self,
        session_id: str,
        checkpoint_type: str,
        content: str,
        tool_name: Optional[str] = None,
        status: Optional[str] = None,
        parent_checkpoint_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Write an agent execution reasoning step into persistent SQLite audit log."""
        args: Dict[str, Any] = {
            "session_id": session_id,
            "checkpoint_type": checkpoint_type,
            "content": content
        }
        if tool_name:
            args["tool_name"] = tool_name
        if status:
            args["status"] = status
        if parent_checkpoint_id:
            args["parent_checkpoint_id"] = parent_checkpoint_id
        return self._call_tool("log_checkpoint", args)

    def analyze_causality(self, session_id: str) -> Dict[str, Any]:
        """Run BFS causal chain analysis to trace root-cause failure candidates."""
        return self._call_tool("analyze_causality", {"session_id": session_id})
