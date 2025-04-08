# mcp-qdrant-docs MCP Server

A Model Context Protocol server

This is a TypeScript-based MCP server that scrapes website content, indexes it into a Qdrant vector database, and provides a tool to answer questions about the indexed content.

## Features

### Tool: `ask_<sanitized_hostname>_content`
- **Name:** Dynamically generated based on the `DOCS_URL` or `--start-url` (e.g., `ask_reactrouter_com_content`).
- **Functionality:** Allows users to ask natural language questions about the content scraped from the specified website.
- **Process:**
    1. On startup (or if `force-reindex` is specified), the server scrapes the target website.
    2. The scraped content is processed, chunked, and embedded using a sentence transformer model.
    3. These embeddings and content chunks are stored in a Qdrant collection specific to the website.
    4. When the tool is called with a query, the server embeds the query, searches Qdrant for relevant chunks, and returns the found content as the answer.
- **Input:** A natural language query (string).
- **Output:** Text containing the relevant content chunks found in the Qdrant index.

## Installation

To use with Claude Desktop, add the server config:

On MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

### Using `npx`

The recommended way to run this server is using `npx` within your MCP client configuration (e.g., Claude Desktop's `claude_desktop_config.json`). This avoids the need for global installation.

**Example `claude_desktop_config.json` using `npx`:**

```json
{
  "mcpServers": {
    "react-router-docs": { // A unique name for this server instance
      "command": "npx",
      "args": [
        "mcp-qdrant-docs", // The command registered in package.json bin
        // Optional: Add command-line arguments here if needed
        // "--start-url", "https://some-default-url.com/",
        // "--debug"
      ],
      // Optional: Set environment variables for configuration
      "env": {
        "DOCS_URL": "https://reactrouter.com/",
        "QDRANT_URL": "http://your-qdrant-instance:6333",
        "COLLECTION_NAME": "react-router-docs", // Base name for the collection
        "EMBEDDING_MODEL": "sentence-transformers/all-MiniLM-L6-v2"
        // "DEBUG": "true" // Alternative way to enable debug logging
      }
    }
    // You can add more server instances for different documentation sites here
  }
}
```

## Command-Line Options

When running the server directly (e.g., using `npx mcp-qdrant-docs` or `npm run dev --`), you can use the following command-line options. These options override corresponding environment variables if both are set.

-   `--start-url <url>` or `-s <url>`:
    -   **Required (if `DOCS_URL` env var is not set).**
    -   The starting URL of the website to scrape.
    -   Overrides the `DOCS_URL` environment variable.
-   `--limit <number>` or `-l <number>`:
    -   Maximum number of pages to scrape.
    -   Default: `100`.
-   `--match <pattern>` or `-m <pattern>`:
    -   URL path patterns (prefix match) to limit scraping. Can be specified multiple times.
    -   Example: `--match /docs/ --match /api/`
    -   Default: Scrapes all pages under the `start-url` domain.
-   `--force-reindex`:
    -   Force re-scraping and re-indexing even if the Qdrant collection already exists.
    -   Default: `false`.
-   `--collection-name <name>` or `-c <name>`:
    -   Base name for the Qdrant collection. The final collection name will be `<base_name>-<sanitized_hostname>`.
    -   Overrides the `COLLECTION_NAME` environment variable.
    -   Default: `docs-collection`.
-   `--qdrant-url <url>`:
    -   URL of the Qdrant instance.
    -   Overrides the `QDRANT_URL` environment variable.
    -   Default: `http://localhost:6333`.
-   `--embedding-model <model_name>`:
    -   Name of the sentence transformer model to use for embeddings (from Hugging Face or local).
    -   Overrides the `EMBEDDING_MODEL` environment variable.
    -   Default: `Xenova/all-MiniLM-L6-v2`.
-   `--debug`:
    -   Enable detailed debug logging.
    -   Overrides the `DEBUG` environment variable (if set to `true`).
    -   Default: `false`.
-   `--help` or `-h`:
    -   Show the help message listing all options.

**Example using command-line options:**

```bash
npx mcp-qdrant-docs --start-url https://example-docs.com/ --collection-name my-docs --limit 50 --debug
```

**Configuration Priority:**

The server uses the following priority for settings:

1.  **Command-line arguments:** (e.g., `--start-url`, `--collection-name`) - Highest priority.
2.  **Environment variables:** (e.g., `DOCS_URL`, `COLLECTION_NAME`) - Used if command-line arguments are not provided.
3.  **Default values:** (Defined within the code) - Lowest priority.

## Example: Adding React Router Documentation

To add a server instance specifically for querying React Router documentation, add the following entry to your `mcpServers` configuration (e.g., in `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    // ... other servers ...
    "react-router-docs": {
      "command": "npx", // Or the direct path if not installed globally
      "args": [
        "mcp-qdrant-docs"
        // No need to specify --start-url etc. if using env vars
      ],
      "env": {
        "DOCS_URL": "https://reactrouter.com/",
        "QDRANT_URL": "http://your-qdrant-instance:6333", // Replace with your Qdrant URL
        "COLLECTION_NAME": "react-router-docs", // Base name, will become 'react-router-docs-reactrouter_com'
        "EMBEDDING_MODEL": "sentence-transformers/all-MiniLM-L6-v2" // Or your preferred model
        // "DEBUG": "true" // Enable debug logs if needed
      }
    }
    // ... other servers ...
  }
}

```

**Resulting Tool:**

Once this server instance is running and connected to your MCP client, it will provide a tool named similar to `ask_reactrouter_com_content`.

-   **Tool Name:** `ask_<sanitized_hostname>_content` (e.g., `ask_reactrouter_com_content`)
-   **Description:** Ask a question about the content of the site specified by `DOCS_URL` (or `--start-url`).
-   **Input:** A natural language query about the documentation.

The server will automatically scrape the site (if the collection doesn't exist or `--force-reindex` is used), index the content into the specified Qdrant collection (`react-router-docs-reactrouter_com` in this example), and then use the index to answer your queries via the provided tool.
