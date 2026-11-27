# Changelog

## [0.8.0] - 2026-11-27

### Changed
- Clay Agent is now Clay CLI. The package is `@panphora/claycli` and the command is `claycli`. The home page is [claycli.com](https://claycli.com).
- New sign-ins are saved in `~/.config/claycli/credentials.json`.
- The variables are `CLAY_CLI_KEY` and `CLAY_CLI_URL`.
- An MCP client now sees the server as `claycli`.
- Everything set up under the old name keeps working. `npx -y @panphora/clay-agent ...` passes every command to this package at the same version, a key saved by `clay-agent login` still signs you in (and `logout` removes it), and `CLAY_AGENT_KEY` and `CLAY_AGENT_URL` are read when the new variables are not set.

### Fixed
- A malformed key in the saved credentials file is no longer reported as a bad `CLAY_AGENT_KEY`.
- When a credentials file cannot be read, the message names the file.

## [0.7.0] - 2026-11-20

### Added
- `write_data` and `restore_version` answer with `undoVersionId`, the version the write replaced, when the host names one.

## [0.6.1] - 2026-11-14

### Fixed
- HTML requests to a Clay lane are no longer rejected for carrying browser headers.

## [0.6.0] - 2026-11-14

### Added
- HTML Clay documents can be read through the local agent lane. Served folder addresses resolve to the files they point at.
- Data in HTML Clay documents can be saved, restored and written. Each change keeps a single operation id while its outcome is unknown.

### Changed
- HTML Clay's served folders and agent token are now found in its own config folder, not in a Hyperclay Local file.

## [0.5.1] - 2026-11-14

### Added
- Hints on `recovery-unavailable`, `operation-reused` and `save-already-applied` results from the HyperClay host, so a caller can tell these cases apart.

### Changed
- An operation id can be reused when calling the HyperClay host.

## [0.5.0] - 2026-11-14

### Added
- `@panphora/clay-agent/hosted` answers MCP over HTTP inside hyperclay.com, with the same tools as the stdio server except publishing and hosting.
- `create_document` and the `clay-agent create` command make a new `.html` or `.htmlclay` file.

### Changed
- In hosted mode, documents over 100,000 characters are not parsed. Literal text search still works on them, without element paths.
- In hosted mode, `edit_document` stops scanning once a find is known to be ambiguous.
- In hosted mode, at most four regex searches run at a time.

## [0.4.0] - 2026-11-12

### Added
- Publish a local folder as a site with `publish` or the `publish_site` tool. It sends only what changed, never deletes anything on hyperclay.com, and claims the subdomain last.
- Claim a subdomain for a site folder (a folder that holds its own `site.json`), from the CLI with `subdomain --site` or through MCP with `claim_subdomain`.
- List your site folders (`sites` and `list_sites`) and the files in a folder (`files` and `list_files`).
- Add a custom domain to a document or a site folder and check its DNS records and status (`domain add`, `domain status`, `add_domain` and `domain_status`). Agents can add domains, never remove them.
- A clear "hyperclay.com does not offer this yet." answer when hyperclay.com is older than clay-agent.

## [0.2.1] - 2026-11-07

### Changed
- No user-facing changes.

## [0.2.0] - 2026-11-06

### Added
- Claim a subdomain for a document from the CLI or through MCP.

## [0.1.1] - 2026-11-01

### Changed
- No user-facing changes.

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
