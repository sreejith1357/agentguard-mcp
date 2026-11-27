import asyncio
import json
from typing import Any, Dict, List, Optional, Union
import httpx
from .client import AgentGuardError


class AsyncAgentGuardClient:
    """
    Asynchronous Python Client SDK for AgentGuard MCP v3.1.2.
    Designed for async frameworks (LangChain, LlamaIndex, FastAPI, asyncio agents).
    """

    def __init__(
        self,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: float = 10.0,
        base_url: Optional[str] = None,
        max_retries: int = 2,
    ):
        resolved_url = base_url or endpoint or "http://localhost:3000"
        self.endpoint = resolved_url.rstrip("/")
        self.base_url = self.endpoint
        self.api_key = api_key
        self.timeout = timeout
        self.max_retries = max(0, max_retries)
        self.headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if api_key:
            self.headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.AsyncClient(headers=self.headers, timeout=self.timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncAgentGuardClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.aclose()

    async def _call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.endpoint}/mcp"
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments,
            },
        }

        last_exc: Optional[Exception] = None
        for attempt in range(self.max_retries + 1):
            try:
                response = await self._client.post(url, json=payload)
                if response.status_code == 429:
                    err_data = response.json()
                    raise AgentGuardError(f"Rate limit / Quota exceeded: {err_data.get('message')}")
                if response.status_code in (401, 403):
                    err_data = response.json()
                    raise AgentGuardError(f"Auth error ({response.status_code}): {err_data.get('message')}")

                if response.status_code >= 500 and attempt < self.max_retries:
                    await asyncio.sleep(0.25 * (2 ** attempt))
                    continue

                response.raise_for_status()
                content_type = response.headers.get("content-type", "").lower()
                if "text/event-stream" in content_type or response.text.lstrip().startswith("event:"):
                    data = {}
                    for line in response.text.splitlines():
                        if line.startswith("data: "):
                            data = json.loads(line[6:])
                            break
                    if not data:
                        raise AgentGuardError(f"Empty SSE response from MCP server: {response.text[:200]}")
                else:
                    data = response.json()

                if "error" in data:
                    raise AgentGuardError(f"MCP Error: {data['error']}")

                result = data.get("result", {})
                content = result.get("content", [])
                if content and isinstance(content, list) and "text" in content[0]:
                    try:
                        return json.loads(content[0]["text"])
                    except Exception:
                        return {"raw": content[0]["text"]}

                return result
            except (httpx.TransportError, httpx.TimeoutException) as e:
                last_exc = e
                if attempt < self.max_retries:
                    await asyncio.sleep(0.25 * (2 ** attempt))
                    continue
                raise AgentGuardError(f"HTTP request failed after {attempt + 1} attempts: {e}") from e
            except httpx.HTTPError as e:
                raise AgentGuardError(f"HTTP request failed: {e}") from e

        raise AgentGuardError(f"HTTP request failed: {last_exc}")

    async def health_check(
        self,
        url: str,
        expected_status: int = 200,
        timeout_ms: int = 5000,
        expected_body_contains: Optional[str] = None,
        include_headers: bool = False,
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {
            "url": url,
            "expected_status": expected_status,
            "timeout_ms": timeout_ms,
        }
        if expected_body_contains is not None:
            args["expected_body_contains"] = expected_body_contains
        if include_headers:
            args["include_headers"] = True
        return await self._call_tool("health_check", args)

    async def validate_tool_response(
        self,
        data: Union[str, Dict[str, Any], List[Any]],
        schema: Optional[Dict[str, str]] = None,
        required_fields: Optional[List[str]] = None,
        max_age_seconds: Optional[float] = None,
        custom_rules: Optional[List[Dict[str, Any]]] = None,
        check_prompt_injection: bool = True,
        tool_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {"data": data, "check_prompt_injection": check_prompt_injection}
        if schema is not None:
            args["schema"] = schema
        if required_fields is not None:
            args["required_fields"] = required_fields
        if max_age_seconds is not None:
            args["max_age_seconds"] = max_age_seconds
        if custom_rules is not None:
            args["custom_rules"] = custom_rules
        if tool_name is not None:
            args["tool_name"] = tool_name
        return await self._call_tool("validate_tool_response", args)

    async def get_circuit_state(self, tool_name: str, check_cooldown: bool = True) -> Dict[str, Any]:
        return await self._call_tool("get_circuit_state", {"tool_name": tool_name, "check_cooldown": check_cooldown})

    async def check_circuit(self, tool_name: str, check_cooldown: bool = True) -> Dict[str, Any]:
        return await self.get_circuit_state(tool_name, check_cooldown=check_cooldown)

    async def report_tool_result(
        self,
        tool_name: str,
        success: bool,
        error_message: Optional[str] = None,
        response_time_ms: Optional[float] = None,
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {"tool_name": tool_name, "success": success}
        if error_message:
            args["error_message"] = error_message
        if response_time_ms is not None:
            args["response_time_ms"] = response_time_ms
        return await self._call_tool("report_tool_result", args)

    async def reset_circuit(
        self, tool_name: str, reason: Optional[str] = None, reset_counters: bool = False
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {"tool_name": tool_name, "reset_counters": reset_counters}
        if reason is not None:
            args["reason"] = reason
        return await self._call_tool("reset_circuit", args)

    async def detect_anomaly(
        self,
        value: Union[float, int, str],
        metric_name: str,
        baseline: Optional[List[Any]] = None,
        sensitivity: str = "medium",
        context: Optional[str] = None,
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {"value": value, "metric_name": metric_name, "sensitivity": sensitivity}
        if baseline is not None:
            args["baseline"] = baseline
        if context is not None:
            args["context"] = context
        return await self._call_tool("detect_anomaly", args)

    async def record_observation(
        self,
        metric_name: str,
        value: float,
        window_size: Optional[int] = None,
        context: Optional[str] = None,
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {"metric_name": metric_name, "value": value}
        if window_size is not None:
            args["window_size"] = window_size
        if context is not None:
            args["context"] = context
        return await self._call_tool("record_observation", args)

    async def get_learned_baseline(
        self, metric_name: str, include_recent_observations: bool = False
    ) -> Dict[str, Any]:
        return await self._call_tool(
            "get_learned_baseline",
            {"metric_name": metric_name, "include_recent_observations": include_recent_observations},
        )

    async def reset_baseline(
        self, metric_name: str, hard_delete: bool = True, reason: Optional[str] = None
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {"metric_name": metric_name, "hard_delete": hard_delete}
        if reason is not None:
            args["reason"] = reason
        return await self._call_tool("reset_baseline", args)

    async def log_checkpoint(
        self,
        session_id: str,
        checkpoint_type: str = "tool_call",
        content: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        tags: Optional[List[str]] = None,
        parent_checkpoint_id: Optional[str] = None,
        tool_name: Optional[str] = None,
        status: Optional[str] = None,
        tool_input: Optional[Any] = None,
        step_index: Optional[int] = None,
    ) -> Dict[str, Any]:
        resolved_content = content or (f"Tool call: {tool_name}" if tool_name else "Checkpoint")
        args: Dict[str, Any] = {
            "session_id": session_id,
            "checkpoint_type": checkpoint_type,
            "content": resolved_content,
        }
        if metadata is not None:
            args["metadata"] = metadata
        if tags is not None:
            args["tags"] = tags
        if parent_checkpoint_id is not None:
            args["parent_checkpoint_id"] = parent_checkpoint_id
        if tool_name is not None:
            args["tool_name"] = tool_name
        if status is not None:
            args["status"] = status
        if tool_input is not None:
            args["tool_input"] = tool_input
        if step_index is not None:
            args["step_index"] = step_index
        return await self._call_tool("log_checkpoint", args)

    async def get_session_history(
        self,
        session_id: str,
        limit: int = 50,
        offset: int = 0,
        checkpoint_type: Optional[str] = None,
        since_timestamp: Optional[str] = None,
        until_timestamp: Optional[str] = None,
        tags: Optional[List[str]] = None,
        tag_match: str = "all",
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {
            "session_id": session_id,
            "limit": limit,
            "offset": offset,
            "tag_match": tag_match,
        }
        if checkpoint_type is not None:
            args["checkpoint_type"] = checkpoint_type
        if since_timestamp is not None:
            args["since_timestamp"] = since_timestamp
        if until_timestamp is not None:
            args["until_timestamp"] = until_timestamp
        if tags is not None:
            args["tags"] = tags
        return await self._call_tool("get_session_history", args)

    async def analyze_causality(
        self,
        session_id: str,
        failed_checkpoint_ids: List[str],
        include_graph: bool = False,
        include_downstream: bool = False,
    ) -> Dict[str, Any]:
        return await self._call_tool(
            "analyze_causality",
            {
                "session_id": session_id,
                "failed_checkpoint_ids": failed_checkpoint_ids,
                "include_graph": include_graph,
                "include_downstream": include_downstream,
            },
        )

