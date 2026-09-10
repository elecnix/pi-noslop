The validator engine the gate uses is pinned.

The fix is not a bigger hammer, it is the orchestrator taking the hard one back.

The gate validates each tool's RESULT against the schema.

Both the gate and the MCP Go SDK run that validator engine.

The parser reads the schema's version from the header.

A silent chunk means fall through to the single bounded REST read instead of looping.
