/**
 * Reusable MCP client for testing.
 * Spawns the MCP Selenium server as a child process and communicates
 * over stdio using JSON-RPC 2.0.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'src', 'lib', 'server.js');
const FIXTURES_DIR = join(__dirname, 'fixtures');

export class McpClient {
    #process = null;
    #buffer = '';
    #requestId = 0;
    #pending = new Map();
    #env;
    #requestTimeoutMs;

    constructor(env = {}, requestTimeoutMs = 60000) {
        this.#env = env;
        this.#requestTimeoutMs = requestTimeoutMs;
    }

    /**
     * Start the MCP server and initialize the connection.
     */
    async start() {
        this.#process = spawn('node', [SERVER_PATH], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...this.#env },
        });

        this.#process.stdout.on('data', (chunk) => {
            this.#buffer += chunk.toString();
            const lines = this.#buffer.split('\n');
            this.#buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.id !== undefined && this.#pending.has(msg.id)) {
                        const pending = this.#pending.get(msg.id);
                        clearTimeout(pending.timer);
                        pending.resolve(msg);
                        this.#pending.delete(msg.id);
                    }
                } catch {
                    // not JSON, ignore
                }
            }
        });

        this.#process.stderr.on('data', (chunk) => {
            // Suppress server stderr unless debugging
            if (process.env.MCP_DEBUG) {
                process.stderr.write(`[server] ${chunk}`);
            }
        });

        this.#process.on('close', (code) => {
            for (const [_id, { reject, timer }] of this.#pending) {
                clearTimeout(timer);
                reject(new Error(`Server process exited unexpectedly (code ${code})`));
            }
            this.#pending.clear();
        });

        // Initialize MCP handshake
        const initResp = await this.#sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'mcp-selenium-tests', version: '1.0.0' },
        });

        if (initResp.error) {
            throw new Error(`MCP init failed: ${JSON.stringify(initResp.error)}`);
        }

        this.#sendNotification('notifications/initialized');

        // Small delay to let the server settle
        await new Promise((r) => setTimeout(r, 300));

        return initResp.result;
    }

    /**
     * Call an MCP tool by name.
     * Returns { content, isError } from the tool response.
     */
    async callTool(name, args = {}) {
        const resp = await this.#sendRequest('tools/call', {
            name,
            arguments: args,
        });
        if (resp.error) {
            throw new Error(`RPC error calling ${name}: ${JSON.stringify(resp.error)}`);
        }
        return resp.result;
    }

    /**
     * List all available tools.
     */
    async listTools() {
        const resp = await this.#sendRequest('tools/list', {});
        if (resp.error) {
            throw new Error(`RPC error listing tools: ${JSON.stringify(resp.error)}`);
        }
        return resp.result.tools;
    }

    /**
     * List all available resources.
     */
    async listResources() {
        const resp = await this.#sendRequest('resources/list', {});
        if (resp.error) {
            throw new Error(`RPC error listing resources: ${JSON.stringify(resp.error)}`);
        }
        return resp.result.resources;
    }

    /**
     * Read a resource by URI.
     */
    async readResource(uri) {
        const resp = await this.#sendRequest('resources/read', { uri });
        if (resp.error) {
            throw new Error(`RPC error reading resource: ${JSON.stringify(resp.error)}`);
        }
        return resp.result;
    }

    /**
     * Stop the server process and clean up.
     */
    async stop() {
        if (this.#process) {
            // Reject all pending requests
            for (const [id, { reject, timer }] of this.#pending) {
                clearTimeout(timer);
                reject(new Error('Client stopped'));
                this.#pending.delete(id);
            }
            const child = this.#process;
            this.#process = null;
            const closed = new Promise((resolve) => child.once('close', resolve));
            child.kill('SIGTERM');
            await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
    }

    #sendRequest(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this.#requestId;
            const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
            const timer = setTimeout(() => {
                if (this.#pending.has(id)) {
                    this.#pending
                        .get(id)
                        .reject(new Error(`Timeout waiting for response to ${method} (id: ${id})`));
                    this.#pending.delete(id);
                }
            }, this.#requestTimeoutMs);
            this.#pending.set(id, { resolve, reject, timer });
            this.#process.stdin.write(`${msg}\n`);
        });
    }

    #sendNotification(method, params = {}) {
        const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
        this.#process.stdin.write(`${msg}\n`);
    }
}

/**
 * Helper to extract text from a tool response.
 */
export function getResponseText(result) {
    return result?.content?.[0]?.text ?? '';
}

/**
 * Returns a file:// URL for a fixture HTML file.
 */
export function fixture(name) {
    return pathToFileURL(join(FIXTURES_DIR, name)).href;
}
