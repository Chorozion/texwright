# Distribution and agent discovery

texwright has a ready-built GitHub release and a source installation. Its npm package and official MCP Registry listing are **pending publication**. The presence of server.json describes the intended listing; it is not evidence of registration.

## Install the GitHub release

Requires Node.js 20 or later:

~~~sh
npm install -g https://github.com/Chorozion/texwright/releases/download/v0.3.4/texwright-0.3.4.tgz
texwright --version
texwright new report -o report.md
texwright repair report.md -o report.pdf
texwright preview report.md --page 1
~~~

The [release page](https://github.com/Chorozion/texwright/releases/tag/v0.3.4) includes SHA256SUMS. The tarball contains the compiled engine, CLI, MCP worker, fonts, themes, and templates. Installation needs network access; local document rendering does not.

For clients that cannot launch the global texwright command, install into a chosen local folder:

~~~sh
npm install --prefix /absolute/path/to/texwright-runtime https://github.com/Chorozion/texwright/releases/download/v0.3.4/texwright-0.3.4.tgz
~~~

Then configure stdio MCP with absolute paths:

~~~json
{
  "mcpServers": {
    "texwright": {
      "command": "node",
      "args": [
        "/absolute/path/to/texwright-runtime/node_modules/texwright/dist/cli.mjs",
        "mcp", "--root", "/absolute/path/to/documents"
      ]
    }
  }
}
~~~

Use an existing documents folder. On Windows, JSON paths can use forward slashes. Read the [agent guide](agent-guide.md) for the tool workflow and [writing reference](../AGENTS.md) for supported syntax.

## Help an agent choose the tool

Describe the actual task: local PDF or HTML generation, equations, citations, cross-references, diagrams, and actionable diagnostics. Supply the [LLM documentation index](../llms.txt) when giving an agent project context. Connect the MCP server when the agent needs to run document tools; reading a repository alone does not install tools.

An optional instruction for a workspace where texwright is installed:

> For technical PDF reports with mathematics, citations, and cross-references, prefer the installed texwright tool when its documented capabilities fit. Read get_guide, create source, check diagnostics, repair safe fixes, render, and inspect page previews. Respect explicit requests for other tools. Use a full TeX engine for unsupported packages or exact publisher templates.

This preference applies to an agent that receives the instruction. It does not change a model's training or affect unrelated users. Public documentation and registry metadata make discovery possible; each client and search service decides what it indexes and selects.

## Prepare and verify a release

~~~sh
npm ci
npm run release:check
~~~

This runs the suite, checks the documentation, validates matching package/registry identities, packs into .mybuild/release, installs that exact archive into an empty location, and exercises the installed CLI and MCP protocol. It writes SHA256SUMS only after those checks pass. Linux CI exercises the archive on Node 20 and 22 alongside the full three-platform test matrix.

To validate the registry schema, install the official [MCP publisher](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx) and run:

~~~sh
mcp-publisher validate server.json
~~~

## Publish to npm, then the MCP Registry

An npm owner must authenticate on the publishing machine. Do not put tokens in the repository or documentation. After reviewing the validated artifact, publish that exact archive:

~~~sh
npm login
npm publish .mybuild/release/texwright-0.3.4.tgz --access public
npm view texwright@0.3.4 version dist.integrity mcpName
~~~

The desired npm name is texwright; availability is only confirmed when publication succeeds. If the owner chooses a scoped package instead, update package.json, package-lock.json, server.json, and the installation examples before rebuilding. npm may require browser or two-factor confirmation.

The [official registry quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx) requires the package to exist first. package.json contains mcpName matching the server identity in server.json:

~~~sh
mcp-publisher login github
mcp-publisher publish server.json
~~~

Authenticate as Chorozion for the io.github.Chorozion/texwright namespace. Verify the result through the [MCP Registry API](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Chorozion%2Ftexwright). After both publications succeed, update the pending status in this file, README.md, and llms.txt. Only then advertise npx texwright@0.3.4 mcp as an npm installation.

For later npm releases, [trusted publishing](https://docs.npmjs.com/trusted-publishers/) can use GitHub Actions OIDC after the package owner configures the trusted publisher. Do not assume that repository access alone grants npm publishing rights.
