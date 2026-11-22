# Experimental fixed-protocol agent preset

Default behavior is unchanged. The bridge sends its inline protocol unless the server operator explicitly enables `QUICK_CODEX_PROTOCOL_PRESET=1` (or `createBridge({protocolPreset:true,...})`). This is an operator setting, never a client-request option.

For persistent local shortcut launches, the private file selected by `QUICK_CLIENT_FILE` may instead contain `"protocolPreset": true`. An explicitly set `QUICK_CODEX_PROTOCOL_PRESET` overrides that file setting (`1` enables, other values disable). Do not add credentials or private configuration to the repository.

## Setup

1. Create a dedicated Quick agent with the exact instructions in `EXTERNAL-HARNESS-PROTOCOL-v1.txt`. Keep the agent private, with no attached connectors or spaces and web search off. Publishing an agent version and sharing it are separate operations; verify its sharing list. Do not change the default Quick agent.
2. Set `protocolAgentArn` in the backend's private session configuration to that agent. It applies only to trusted incremental bridge requests. Ordinary Chat requests retain `agentArn` or the default SYSTEM agent, so they do not inherit the external JSON protocol. The gateway strips caller-supplied incremental/session headers. For the currently tested web transport the ARN form is `arn:aws:quicksight:REGION:ACCOUNT_ID:agent/AGENT_ID`; obtain identifiers from your own account. Do not add private session files or real agent identifiers to the repository.
3. First run an isolated backend and bridge on unused loopback ports (or ephemeral ports). Set the bridge's upstream to that backend and enable preset mode only on that bridge. Use separate temporary service keys. Never enable preset mode against an unverified SYSTEM/default backend.
4. Verify that a request without inline protocol can identify the preset, emit function/custom actions with exact namespace and signatures, obey dynamic instructions and tool choice, and continue after an actual external command result. Native Quick capabilities are not disabled by this JSON protocol; it is an instruction convention, not a security boundary. The external runtime must retain its own sandbox and approvals.

In preset mode, first/rebuilt requests retain `TOOL_CHOICE`, full dynamic `INSTRUCTIONS`, compact dynamic `TOOLS` and ordered `EVENTS`. System/developer messages in the event input remain present. Normal continuations still send only `NEW EVENTS`; missing-session recovery rebuilds dynamic setup using the same mode. Existing validation, owner isolation, output truncation and action parsing remain in effect.

## Validation and limits

An isolated real AWS experiment on 2026-11-22 made five Responses requests covering protocol identification, a namespace function call, actual local Node command execution and same-thread continuation, a namespace custom action with grammar, and `tool_choice:none`. All passed. The actual command returned 323 with exit code 0. This is a controlled harness test, not a complete Codex Desktop/plugin/MCP end-to-end test or a reliability benchmark.

For that small tool fixture, locally generated inline setup was 1100 characters; the actual preset first request was 490, saving 610 (55.45%). The actual continuation was 153 characters. The inline comparator was generated locally, not sent in a second live baseline run. The fixed saving is not a general percentage claim, a token-billing measurement or proof of reduced model context: the preset still supplies instructions to the model.

The test did not restart or modify production services, deploy to a VPS, modify existing credentials, or change client configuration. The preset branch and recovery behavior also have local regression tests. Roll back an eventual deployment by disabling preset mode together with restoring the backend's previous agent selection, then restart the dedicated pair. In-memory response IDs may no longer be valid after restart.
