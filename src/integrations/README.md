# Integrations

Reference integrations connecting LAG substrate to external
orchestration runtimes. Each subdirectory is one integration.

- `agent-sdk/` (Anthropic Agent SDK, added in virtual-org-bootstrap phase 1)

Future integrations (LangGraph, Letta, AutoGen) follow the same shape:
thin wrapper that implements the 8-interface Host contract against
the target runtime's primitives.
