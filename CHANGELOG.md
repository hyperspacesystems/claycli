# Changelog

## [0.1.0] - 2026-10-31

### Added
- A command line tool for reading and editing Hyperclay documents.
- An MCP server connects Claude Code, Claude Desktop and Cursor to Hyperclay documents so they can read and edit them.
- Access is authorized by a Hyperclay agent key.
- Reading a large document stays bounded: an outline within 8,000 characters, CSS selections and ranges within one budget, and search that is either literal or a regex with a time limit.
- Every write is tied to the version of the document the agent read.
- A write with an unknown outcome is reported as unknown.
- The agent key is only sent over https to the host it belongs to.
- The agent key never appears in output.
