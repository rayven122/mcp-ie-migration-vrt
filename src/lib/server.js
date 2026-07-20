#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import pkg from 'selenium-webdriver';
import { z } from 'zod';

const { Builder, By, Key, until, error } = pkg;
const execFileAsync = promisify(execFile);

// Create an MCP server
import { createRequire } from 'node:module';
import { Options as ChromeOptions } from 'selenium-webdriver/chrome.js';
import { Options as EdgeOptions } from 'selenium-webdriver/edge.js';
import { Options as FirefoxOptions } from 'selenium-webdriver/firefox.js';
import { Options as IeOptions, ServiceBuilder as IeServiceBuilder } from 'selenium-webdriver/ie.js';
import { Options as SafariOptions } from 'selenium-webdriver/safari.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

const server = new McpServer(
    { name: 'MCP IE Migration VRT', version },
    {
        instructions:
            'For IE migration VRT, call start_vrt_browsers, operate the returned beforeSessionId and afterSessionId with the standard Selenium tools, then call vrt when both pages show the equivalent UI state. Pass sessionId explicitly whenever multiple browsers are open. The VRT tool compares page viewports only; browser tabs, address bars, and window chrome are excluded.',
    }
);

// BiDi imports — loaded dynamically to avoid hard failures if not available
let LogInspector, Network;
try {
    LogInspector = (await import('selenium-webdriver/bidi/logInspector.js')).default;
    const networkModule = await import('selenium-webdriver/bidi/network.js');
    Network = networkModule.Network;
} catch (_) {
    // BiDi modules not available in this selenium-webdriver version
    LogInspector = null;
    Network = null;
}

// Server state
const state = {
    drivers: new Map(),
    currentSession: null,
    bidi: new Map(),
};

// Helper functions
const getSessionId = (sessionId) => sessionId || state.currentSession;

const getDriver = (sessionId) => {
    const resolvedSessionId = getSessionId(sessionId);
    const driver = state.drivers.get(resolvedSessionId);
    if (!driver) {
        throw new Error(
            sessionId
                ? `Browser session not found: ${sessionId}`
                : 'No active browser session. Pass sessionId or start a browser first.'
        );
    }
    return driver;
};

const sessionIdSchema = z
    .string()
    .optional()
    .describe('Browser session ID. Defaults to the most recently started session.');

const getLocator = (by, value) => {
    switch (by.toLowerCase()) {
        case 'id':
            return By.id(value);
        case 'css':
            return By.css(value);
        case 'xpath':
            return By.xpath(value);
        case 'name':
            return By.name(value);
        case 'tag':
            return By.tagName(value);
        case 'class':
            return By.className(value);
        default:
            throw new Error(`Unsupported locator strategy: ${by}`);
    }
};

const unsafeBrowserArgumentNames = new Set([
    '--allow-file-access-from-files',
    '--allow-running-insecure-content',
    '--disable-web-security',
    '--disable-site-isolation-trials',
    '--disable-features',
    '--disable-extensions-except',
    '--load-extension',
    '--remote-allow-origins',
    '--remote-debugging-address',
    '--remote-debugging-port',
    '--remote-debugging-pipe',
    '--unsafely-treat-insecure-origin-as-secure',
    '--user-data-dir',
]);

const allowUnsafeBrowserArgs = () => process.env.MCP_SELENIUM_ALLOW_UNSAFE_BROWSER_ARGS === '1';

const browserArgName = (arg) => arg.split('=')[0].toLowerCase();

const validateBrowserArguments = (args = []) => {
    if (allowUnsafeBrowserArgs()) return;

    for (const arg of args) {
        if (arg.includes('\0')) {
            throw new Error('Browser arguments must not contain NUL bytes');
        }
        const name = browserArgName(arg);
        if (unsafeBrowserArgumentNames.has(name)) {
            throw new Error(
                `Browser argument "${name}" is blocked by default. Set MCP_SELENIUM_ALLOW_UNSAFE_BROWSER_ARGS=1 to allow it in a trusted environment.`
            );
        }
    }
};

const validateNavigationUrl = (url) => {
    const schemeMatch = url.trim().match(/^([a-z][a-z0-9+.-]*):/i);
    const scheme = schemeMatch?.[1]?.toLowerCase();
    if (scheme === 'javascript' || scheme === 'vbscript') {
        throw new Error(
            `Navigation to ${scheme}: URLs is blocked; use execute_script for explicit JavaScript execution.`
        );
    }
};

const screenshotRoot = () => resolve(process.env.MCP_SELENIUM_SCREENSHOT_DIR || process.cwd());

const resolveScreenshotOutputPath = (outputPath) => {
    if (outputPath.includes('\0')) {
        throw new Error('Screenshot outputPath must not contain NUL bytes');
    }
    if (!outputPath.toLowerCase().endsWith('.png')) {
        throw new Error('Screenshot outputPath must end with .png');
    }

    const root = screenshotRoot();
    const resolvedPath = isAbsolute(outputPath) ? resolve(outputPath) : resolve(root, outputPath);
    const relativePath = relative(root, resolvedPath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error(`Screenshot outputPath must be inside ${root}`);
    }
    return resolvedPath;
};

// BiDi helpers
const newBidiState = () => ({
    available: false,
    consoleLogs: [],
    pageErrors: [],
    networkLogs: [],
});

async function setupBidi(driver, sessionId) {
    const bidi = newBidiState();

    const logInspector = await LogInspector(driver);
    await logInspector.onConsoleEntry((entry) => {
        try {
            bidi.consoleLogs.push({
                level: entry.level,
                text: entry.text,
                timestamp: entry.timestamp,
                type: entry.type,
                method: entry.method,
                args: entry.args,
            });
        } catch (_) {
            /* ignore malformed entry */
        }
    });
    await logInspector.onJavascriptLog((entry) => {
        try {
            bidi.pageErrors.push({
                level: entry.level,
                text: entry.text,
                timestamp: entry.timestamp,
                type: entry.type,
                stackTrace: entry.stackTrace,
            });
        } catch (_) {
            /* ignore malformed entry */
        }
    });

    const network = await Network(driver);
    await network.responseCompleted((event) => {
        try {
            bidi.networkLogs.push({
                type: 'response',
                url: event.request?.url,
                status: event.response?.status,
                method: event.request?.method,
                mimeType: event.response?.mimeType,
                timestamp: Date.now(),
            });
        } catch (_) {
            /* ignore malformed event */
        }
    });
    await network.fetchError((event) => {
        try {
            bidi.networkLogs.push({
                type: 'error',
                url: event.request?.url,
                method: event.request?.method,
                errorText: event.errorText,
                timestamp: Date.now(),
            });
        } catch (_) {
            /* ignore malformed event */
        }
    });

    bidi.available = true;
    state.bidi.set(sessionId, bidi);
}

// Browser-side script loaded from file and executed via WebDriver's executeScript.
const accessibilitySnapshotScript = readFileSync(
    new URL('./accessibility-snapshot.js', import.meta.url),
    'utf-8'
);

// Common schemas
const supportedBrowsers =
    process.platform === 'win32'
        ? ['chrome', 'firefox', 'edge', 'safari', 'edge-ie']
        : ['chrome', 'firefox', 'edge', 'safari'];

const browserOptionsSchema = z
    .object({
        headless: z.boolean().optional().describe('Run browser in headless mode'),
        arguments: z.array(z.string()).optional().describe('Additional browser arguments'),
        edgePath: z
            .string()
            .optional()
            .describe(
                'Path to msedge.exe (edge-ie only; defaults to the standard install path). Windows only.'
            ),
        ieIgnoreZoomSetting: z
            .boolean()
            .optional()
            .describe('Ignore IE protected-mode zone mismatch (edge-ie only)'),
    })
    .optional();

const locatorSchema = {
    sessionId: sessionIdSchema,
    by: z
        .enum(['id', 'css', 'xpath', 'name', 'tag', 'class'])
        .describe('Locator strategy to find element'),
    value: z.string().describe('Value for the locator strategy'),
    timeout: z.number().optional().describe('Maximum time to wait for element in milliseconds'),
};

const pngDimensions = (base64) => {
    const png = Buffer.from(base64, 'base64');
    if (png.length < 24 || png.toString('ascii', 1, 4) !== 'PNG') {
        throw new Error('Screenshot is not a valid PNG');
    }
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

const ensureViewport = async (driver, width, height) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const viewport = await driver.executeScript(
            'return { width: window.innerWidth, height: window.innerHeight };'
        );
        if (viewport.width === width && viewport.height === height) {
            await driver.executeScript('window.scrollTo(0, 0);');
            return viewport;
        }
        const rect = await driver.manage().window().getRect();
        await driver
            .manage()
            .window()
            .setRect({
                width: rect.width + (width - viewport.width),
                height: rect.height + (height - viewport.height),
            });
    }
    const viewport = await driver.executeScript(
        'return { width: window.innerWidth, height: window.innerHeight };'
    );
    throw new Error(
        `Unable to set viewport to ${width}x${height}; actual viewport is ${viewport.width}x${viewport.height}`
    );
};

const findDiffImage = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            const nested = await findDiffImage(path);
            if (nested) return nested;
        } else if (entry.name.endsWith('-diff.png')) {
            return path;
        }
    }
    return undefined;
};

const safeArtifactName = (name) => {
    const artifactName = name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
    if (!artifactName || artifactName === '.' || artifactName === '..') {
        throw new Error('Invalid VRT name');
    }
    return artifactName;
};

const cleanUpSessions = async (sessions) => {
    await Promise.allSettled(
        sessions.map(async ({ driver, sessionId }) => {
            await driver.quit();
            state.drivers.delete(sessionId);
            state.bidi.delete(sessionId);
        })
    );
};

const addBrowserArguments = (webdriverOptions, browserArguments) => {
    browserArguments?.forEach((argument) => {
        webdriverOptions.addArguments(argument);
    });
};

const launchBrowser = async (browser, options = {}) => {
    validateBrowserArguments(options.arguments);

    let builder = new Builder();
    let driver;
    const warnings = [];

    if (LogInspector && Network && browser !== 'edge-ie') {
        builder = builder.withCapabilities({
            webSocketUrl: true,
            unhandledPromptBehavior: 'ignore',
        });
    }

    switch (browser) {
        case 'chrome': {
            const chromeOptions = new ChromeOptions();
            if (options.headless) chromeOptions.addArguments('--headless=new');
            addBrowserArguments(chromeOptions, options.arguments);
            driver = await builder.forBrowser('chrome').setChromeOptions(chromeOptions).build();
            break;
        }
        case 'edge': {
            const edgeOptions = new EdgeOptions();
            if (options.headless) edgeOptions.addArguments('--headless=new');
            addBrowserArguments(edgeOptions, options.arguments);
            driver = await builder.forBrowser('MicrosoftEdge').setEdgeOptions(edgeOptions).build();
            break;
        }
        case 'firefox': {
            const firefoxOptions = new FirefoxOptions();
            if (options.headless) firefoxOptions.addArguments('--headless');
            addBrowserArguments(firefoxOptions, options.arguments);
            driver = await builder.forBrowser('firefox').setFirefoxOptions(firefoxOptions).build();
            break;
        }
        case 'safari': {
            const safariOptions = new SafariOptions();
            if (options.headless) {
                warnings.push(
                    'Safari does not support headless mode — launching with visible window.'
                );
            }
            if (options.arguments?.length) {
                warnings.push('Safari does not support custom arguments — ignoring.');
            }
            driver = await builder.forBrowser('safari').setSafariOptions(safariOptions).build();
            break;
        }
        case 'edge-ie': {
            if (process.platform !== 'win32') {
                throw new Error('Edge IE mode is only supported on Windows.');
            }
            const ieOptions = new IeOptions();
            ieOptions.setEdgeChromium(true);
            ieOptions.setEdgePath(
                options.edgePath ||
                    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
            );
            if (process.env.MCP_IE_DRIVER_LOG) {
                builder.setIeService(
                    new IeServiceBuilder().addArguments(
                        '--log-level=TRACE',
                        `--log-file=${process.env.MCP_IE_DRIVER_LOG}`
                    )
                );
            }
            if (options.ieIgnoreZoomSetting) ieOptions.ignoreZoomSetting(true);
            if (options.headless) {
                warnings.push(
                    'Edge IE mode does not support headless — launching with a visible window.'
                );
            }
            addBrowserArguments(ieOptions, options.arguments);
            driver = await builder.forBrowser('internet explorer').setIeOptions(ieOptions).build();
            break;
        }
        default:
            throw new Error(`Unsupported browser: ${browser}`);
    }

    const sessionId = `${browser}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    state.drivers.set(sessionId, driver);
    state.currentSession = sessionId;

    if (LogInspector && Network && browser !== 'edge-ie') {
        try {
            await setupBidi(driver, sessionId);
        } catch (_) {
            // BiDi is optional and unavailable with some browser/driver combinations.
        }
    }

    return { driver, sessionId, warnings, bidi: state.bidi.get(sessionId)?.available === true };
};

// Browser Management Tools
server.registerTool(
    'start_browser',
    {
        description: 'launches browser',
        inputSchema: {
            browser: z
                .enum(supportedBrowsers)
                .describe(
                    "Browser to launch. On Windows, 'edge-ie' drives Microsoft Edge in Internet Explorer (IE) mode and requires IEDriverServer on PATH."
                ),
            options: browserOptionsSchema,
        },
    },
    async ({ browser, options = {} }) => {
        try {
            const { sessionId, warnings, bidi } = await launchBrowser(browser, options);

            let message = `Browser started with session_id: ${sessionId}`;
            if (bidi) {
                message +=
                    ' (BiDi enabled: console logs, JS errors, and network activity are being captured)';
            }
            if (warnings.length > 0) {
                message += `\nWarnings: ${warnings.join(' ')}`;
            }

            return {
                content: [{ type: 'text', text: message }],
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error starting browser: ${e.message}` }],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'navigate',
    {
        description: 'navigates to a URL',
        inputSchema: {
            sessionId: sessionIdSchema,
            url: z.string().describe('URL to navigate to'),
        },
    },
    async ({ sessionId, url }) => {
        try {
            validateNavigationUrl(url);
            const driver = getDriver(sessionId);
            await driver.get(url);
            return {
                content: [{ type: 'text', text: `Navigated to ${url}` }],
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error navigating: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// Element Interaction Tools
server.registerTool(
    'interact',
    {
        description: 'performs a mouse action on an element',
        inputSchema: {
            action: z
                .enum(['click', 'doubleclick', 'rightclick', 'hover'])
                .describe('Mouse action to perform'),
            ...locatorSchema,
        },
    },
    async ({ sessionId, action, by, value, timeout = 10000 }) => {
        try {
            const driver = getDriver(sessionId);
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);

            switch (action) {
                case 'click':
                    await element.click();
                    return { content: [{ type: 'text', text: 'Element clicked' }] };
                case 'doubleclick': {
                    const dblActions = driver.actions({ bridge: true });
                    await dblActions.doubleClick(element).perform();
                    return { content: [{ type: 'text', text: 'Double click performed' }] };
                }
                case 'rightclick': {
                    const ctxActions = driver.actions({ bridge: true });
                    await ctxActions.contextClick(element).perform();
                    return { content: [{ type: 'text', text: 'Right click performed' }] };
                }
                case 'hover': {
                    const hoverActions = driver.actions({ bridge: true });
                    await hoverActions.move({ origin: element }).perform();
                    return { content: [{ type: 'text', text: 'Hovered over element' }] };
                }
                default:
                    return {
                        content: [{ type: 'text', text: `Unknown action: ${action}` }],
                        isError: true,
                    };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error performing ${action}: ${e.message}` }],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'send_keys',
    {
        description: 'sends keys to an element, aka typing. Clears the field first.',
        inputSchema: {
            ...locatorSchema,
            text: z.string().describe('Text to enter into the element'),
        },
    },
    async ({ sessionId, by, value, text, timeout = 10000 }) => {
        try {
            const driver = getDriver(sessionId);
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            await element.clear();
            await element.sendKeys(text);
            return {
                content: [{ type: 'text', text: `Text "${text}" entered into element` }],
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error entering text: ${e.message}` }],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'get_element_text',
    {
        description: 'gets the text content of an element',
        inputSchema: {
            ...locatorSchema,
        },
    },
    async ({ sessionId, by, value, timeout = 10000 }) => {
        try {
            const driver = getDriver(sessionId);
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const text = await element.getText();
            return {
                content: [{ type: 'text', text }],
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error getting element text: ${e.message}` }],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'press_key',
    {
        description: 'simulates pressing a keyboard key',
        inputSchema: {
            sessionId: sessionIdSchema,
            key: z.string().describe("Key to press (e.g., 'Enter', 'Tab', 'a', etc.)"),
        },
    },
    async ({ sessionId, key }) => {
        try {
            const driver = getDriver(sessionId);
            const resolvedKey =
                key.length === 1 ? key : (Key[key.toUpperCase().replace(/ /g, '_')] ?? null);
            if (resolvedKey === null) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error pressing key: Unknown key name '${key}'. Use a single character or a named key like 'Enter', 'Tab', 'Escape', etc.`,
                        },
                    ],
                    isError: true,
                };
            }
            const actions = driver.actions({ bridge: true });
            await actions.keyDown(resolvedKey).keyUp(resolvedKey).perform();
            return {
                content: [{ type: 'text', text: `Key '${key}' pressed` }],
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error pressing key: ${e.message}` }],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'upload_file',
    {
        description: 'uploads a file using a file input element',
        inputSchema: {
            ...locatorSchema,
            filePath: z.string().describe('Absolute path to the file to upload'),
        },
    },
    async ({ sessionId, by, value, filePath, timeout = 10000 }) => {
        try {
            const driver = getDriver(sessionId);
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            await element.sendKeys(filePath);
            return {
                content: [{ type: 'text', text: 'File upload initiated' }],
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error uploading file: ${e.message}` }],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'take_screenshot',
    {
        description:
            'captures a screenshot of the current page. Prefer using the accessibility://current resource for understanding page content. Use get_element_text, get_element_attribute, or execute_script to verify element state. Only use screenshots when visual layout or styling needs to be verified.',
        inputSchema: {
            sessionId: sessionIdSchema,
            outputPath: z
                .string()
                .optional()
                .describe(
                    'Optional path where to save the screenshot. If not provided, returns an image/png content block.'
                ),
        },
    },
    async ({ sessionId, outputPath }) => {
        try {
            const driver = getDriver(sessionId);
            const screenshot = await driver.takeScreenshot();
            if (outputPath) {
                const resolvedOutputPath = resolveScreenshotOutputPath(outputPath);
                const fs = await import('node:fs');
                await fs.promises.writeFile(resolvedOutputPath, screenshot, 'base64');
                return {
                    content: [{ type: 'text', text: `Screenshot saved to ${resolvedOutputPath}` }],
                };
            } else {
                return {
                    content: [{ type: 'image', data: screenshot, mimeType: 'image/png' }],
                };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error taking screenshot: ${e.message}` }],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'accessibility_snapshot',
    {
        description:
            'returns a compact accessibility snapshot for a selected browser session. Use it to inspect both VRT browsers without changing the current session.',
        inputSchema: { sessionId: sessionIdSchema },
    },
    async ({ sessionId }) => {
        try {
            const driver = getDriver(sessionId);
            const tree = (await driver.executeScript(accessibilitySnapshotScript)) || {};
            return {
                content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }],
            };
        } catch (e) {
            return {
                content: [
                    { type: 'text', text: `Error capturing accessibility snapshot: ${e.message}` },
                ],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'close_session',
    {
        description: 'closes the current browser session',
        inputSchema: { sessionId: sessionIdSchema },
    },
    async ({ sessionId }) => {
        try {
            const resolvedSessionId = getSessionId(sessionId);
            const driver = getDriver(resolvedSessionId);
            try {
                await driver.quit();
            } finally {
                state.drivers.delete(resolvedSessionId);
                state.bidi.delete(resolvedSessionId);
                if (state.currentSession === resolvedSessionId) state.currentSession = null;
            }
            return {
                content: [{ type: 'text', text: `Browser session ${resolvedSessionId} closed` }],
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error closing session: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// Element Utility Tools
server.registerTool(
    'get_element_attribute',
    {
        description:
            'gets the value of an attribute on an element. Use this to verify element state. Prefer this over screenshots for validation.',
        inputSchema: {
            ...locatorSchema,
            attribute: z
                .string()
                .describe("Name of the attribute to get (e.g., 'href', 'value', 'class')"),
        },
    },
    async ({ sessionId, by, value, attribute, timeout = 10000 }) => {
        try {
            const driver = getDriver(sessionId);
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const attrValue = await element.getAttribute(attribute);
            return {
                content: [{ type: 'text', text: attrValue !== null ? attrValue : '' }],
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error getting attribute: ${e.message}` }],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'execute_script',
    {
        description:
            'executes JavaScript in the browser and returns the result. Use for advanced interactions not covered by other tools (e.g., drag and drop, scrolling, reading computed styles, manipulating the DOM directly). Also useful for batch-reading multiple element values/states in a single call instead of multiple get_element_attribute calls.',
        inputSchema: {
            sessionId: sessionIdSchema,
            script: z.string().describe('JavaScript code to execute in the browser'),
            args: z
                .array(z.any())
                .optional()
                .describe(
                    'Optional arguments to pass to the script (accessible via arguments[0], arguments[1], etc.)'
                ),
        },
    },
    async ({ sessionId, script, args = [] }) => {
        try {
            const driver = getDriver(sessionId);
            const result = await driver.executeScript(script, ...args);
            const text =
                result === undefined || result === null
                    ? 'Script executed (no return value)'
                    : typeof result === 'object'
                      ? JSON.stringify(result, null, 2)
                      : String(result);
            return {
                content: [{ type: 'text', text }],
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error executing script: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// Window/Tab Management
server.registerTool(
    'window',
    {
        description: 'manages browser windows and tabs',
        inputSchema: {
            sessionId: sessionIdSchema,
            action: z
                .enum(['list', 'switch', 'switch_latest', 'close'])
                .describe('Window action to perform'),
            handle: z.string().optional().describe('Window handle (required for switch)'),
        },
    },
    async ({ sessionId, action, handle }) => {
        try {
            const resolvedSessionId = getSessionId(sessionId);
            const driver = getDriver(resolvedSessionId);
            switch (action) {
                case 'list': {
                    const handles = await driver.getAllWindowHandles();
                    const current = await driver.getWindowHandle();
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({ current, all: handles }, null, 2),
                            },
                        ],
                    };
                }
                case 'switch': {
                    if (!handle) throw new Error('handle is required for switch action');
                    await driver.switchTo().window(handle);
                    return { content: [{ type: 'text', text: `Switched to window: ${handle}` }] };
                }
                case 'switch_latest': {
                    const handles = await driver.getAllWindowHandles();
                    if (handles.length === 0) throw new Error('No windows available');
                    const latest = handles[handles.length - 1];
                    await driver.switchTo().window(latest);
                    return {
                        content: [{ type: 'text', text: `Switched to latest window: ${latest}` }],
                    };
                }
                case 'close': {
                    await driver.close();
                    let handles = [];
                    try {
                        handles = await driver.getAllWindowHandles();
                    } catch (_) {
                        /* session gone */
                    }
                    if (handles.length > 0) {
                        await driver.switchTo().window(handles[0]);
                        return {
                            content: [
                                { type: 'text', text: `Window closed. Switched to: ${handles[0]}` },
                            ],
                        };
                    }
                    try {
                        await driver.quit();
                    } catch (_) {
                        /* ignore */
                    }
                    state.drivers.delete(resolvedSessionId);
                    state.bidi.delete(resolvedSessionId);
                    if (state.currentSession === resolvedSessionId) state.currentSession = null;
                    return {
                        content: [{ type: 'text', text: 'Last window closed. Session ended.' }],
                    };
                }
                default:
                    return {
                        content: [{ type: 'text', text: `Unknown action: ${action}` }],
                        isError: true,
                    };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error in window ${action}: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// Frame Management
server.registerTool(
    'frame',
    {
        description: 'switches focus to a frame or back to the main page',
        inputSchema: {
            sessionId: sessionIdSchema,
            action: z.enum(['switch', 'default']).describe('Frame action to perform'),
            by: z
                .enum(['id', 'css', 'xpath', 'name', 'tag', 'class'])
                .optional()
                .describe('Locator strategy for frame element'),
            value: z.string().optional().describe('Value for the locator strategy'),
            index: z.number().optional().describe('Frame index (0-based)'),
            timeout: z.number().optional().describe('Max wait in ms'),
        },
    },
    async ({ sessionId, action, by, value, index, timeout = 10000 }) => {
        try {
            const driver = getDriver(sessionId);
            if (action === 'default') {
                await driver.switchTo().defaultContent();
                return { content: [{ type: 'text', text: 'Switched to default content' }] };
            }
            // action === 'switch'
            if (index !== undefined) {
                await driver.switchTo().frame(index);
            } else if (by && value) {
                const locator = getLocator(by, value);
                const element = await driver.wait(until.elementLocated(locator), timeout);
                await driver.switchTo().frame(element);
            } else {
                throw new Error(
                    'Provide either by/value to locate frame, or index to switch by position'
                );
            }
            return { content: [{ type: 'text', text: 'Switched to frame' }] };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error in frame ${action}: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// Alert/Dialog Handling
server.registerTool(
    'alert',
    {
        description: 'handles a browser alert, confirm, or prompt dialog',
        inputSchema: {
            sessionId: sessionIdSchema,
            action: z
                .enum(['accept', 'dismiss', 'get_text', 'send_text'])
                .describe('Action to perform on the alert'),
            text: z.string().optional().describe('Text to send (required for send_text)'),
            timeout: z.number().optional().describe('Max wait in ms'),
        },
    },
    async ({ sessionId, action, text, timeout = 5000 }) => {
        try {
            const driver = getDriver(sessionId);
            await driver.wait(until.alertIsPresent(), timeout);
            const alertObj = await driver.switchTo().alert();
            switch (action) {
                case 'accept':
                    await alertObj.accept();
                    return { content: [{ type: 'text', text: 'Alert accepted' }] };
                case 'dismiss':
                    await alertObj.dismiss();
                    return { content: [{ type: 'text', text: 'Alert dismissed' }] };
                case 'get_text': {
                    const alertText = await alertObj.getText();
                    return { content: [{ type: 'text', text: alertText }] };
                }
                case 'send_text': {
                    if (text === undefined)
                        throw new Error('text is required for send_text action');
                    await alertObj.sendKeys(text);
                    await alertObj.accept();
                    return {
                        content: [
                            { type: 'text', text: `Text "${text}" sent to prompt and accepted` },
                        ],
                    };
                }
                default:
                    return {
                        content: [{ type: 'text', text: `Unknown action: ${action}` }],
                        isError: true,
                    };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error in alert ${action}: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// Cookie Management Tools
server.registerTool(
    'add_cookie',
    {
        description:
            "adds a cookie to the current browser session. The browser must be on a page from the cookie's domain before setting it.",
        inputSchema: {
            sessionId: sessionIdSchema,
            name: z.string().describe('Name of the cookie'),
            value: z.string().describe('Value of the cookie'),
            domain: z.string().optional().describe('Domain the cookie is visible to'),
            path: z.string().optional().describe('Path the cookie is visible to'),
            secure: z.boolean().optional().describe('Whether the cookie is a secure cookie'),
            httpOnly: z.boolean().optional().describe('Whether the cookie is HTTP only'),
            expiry: z
                .number()
                .optional()
                .describe('Expiry date of the cookie as a Unix timestamp (seconds since epoch)'),
        },
    },
    async ({ sessionId, name, value, domain, path, secure, httpOnly, expiry }) => {
        try {
            const driver = getDriver(sessionId);
            const cookie = { name, value };
            if (domain !== undefined) cookie.domain = domain;
            if (path !== undefined) cookie.path = path;
            if (secure !== undefined) cookie.secure = secure;
            if (httpOnly !== undefined) cookie.httpOnly = httpOnly;
            if (expiry !== undefined) cookie.expiry = expiry;
            await driver.manage().addCookie(cookie);
            return {
                content: [{ type: 'text', text: `Cookie "${name}" added` }],
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error adding cookie: ${e.message}` }],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'get_cookies',
    {
        description:
            'retrieves cookies from the current browser session. Returns all cookies or a specific cookie by name.',
        inputSchema: {
            sessionId: sessionIdSchema,
            name: z
                .string()
                .optional()
                .describe(
                    'Name of a specific cookie to retrieve. If omitted, all cookies are returned.'
                ),
        },
    },
    async ({ sessionId, name }) => {
        try {
            const driver = getDriver(sessionId);
            if (name) {
                try {
                    const cookie = await driver.manage().getCookie(name);
                    if (!cookie) {
                        return {
                            content: [{ type: 'text', text: `Cookie "${name}" not found` }],
                            isError: true,
                        };
                    }
                    return {
                        content: [{ type: 'text', text: JSON.stringify(cookie, null, 2) }],
                    };
                } catch (cookieError) {
                    if (cookieError instanceof error.NoSuchCookieError) {
                        return {
                            content: [{ type: 'text', text: `Cookie "${name}" not found` }],
                            isError: true,
                        };
                    }
                    throw cookieError;
                }
            } else {
                const cookies = await driver.manage().getCookies();
                return {
                    content: [{ type: 'text', text: JSON.stringify(cookies, null, 2) }],
                };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error getting cookies: ${e.message}` }],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'delete_cookie',
    {
        description:
            'deletes cookies from the current browser session. Can delete a specific cookie by name or all cookies.',
        inputSchema: {
            sessionId: sessionIdSchema,
            name: z
                .string()
                .optional()
                .describe('Name of the cookie to delete. If omitted, all cookies are deleted.'),
        },
    },
    async ({ sessionId, name }) => {
        try {
            const driver = getDriver(sessionId);
            if (name) {
                await driver.manage().deleteCookie(name);
                return {
                    content: [{ type: 'text', text: `Cookie "${name}" deleted` }],
                };
            } else {
                await driver.manage().deleteAllCookies();
                return {
                    content: [{ type: 'text', text: 'All cookies deleted' }],
                };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error deleting cookie: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// BiDi Diagnostic Tools
const diagnosticTypes = {
    console: { logKey: 'consoleLogs', emptyMessage: 'No console logs captured' },
    errors: { logKey: 'pageErrors', emptyMessage: 'No page errors captured' },
    network: { logKey: 'networkLogs', emptyMessage: 'No network activity captured' },
};

server.registerTool(
    'diagnostics',
    {
        description:
            'retrieves browser diagnostics (console logs, JS errors, or network activity) captured via WebDriver BiDi',
        inputSchema: {
            sessionId: sessionIdSchema,
            type: z
                .enum(['console', 'errors', 'network'])
                .describe('Type of diagnostic data to retrieve'),
            clear: z.boolean().optional().describe('Clear after returning (default: false)'),
        },
    },
    async ({ sessionId, type, clear = false }) => {
        try {
            const resolvedSessionId = getSessionId(sessionId);
            getDriver(resolvedSessionId);
            const bidi = state.bidi.get(resolvedSessionId);
            if (!bidi?.available) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: 'Diagnostics not available (BiDi not supported by this browser/driver)',
                        },
                    ],
                };
            }
            const { logKey, emptyMessage } = diagnosticTypes[type];
            const logs = bidi[logKey];
            const result = logs.length === 0 ? emptyMessage : JSON.stringify(logs, null, 2);
            if (clear) bidi[logKey] = [];
            return { content: [{ type: 'text', text: result }] };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error getting diagnostics: ${e.message}` }],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'start_vrt_browsers',
    {
        description:
            'Starts two linked Selenium sessions for IE migration VRT: Edge IE mode for before and Chromium Edge for after. Returns both session IDs for use with every standard browser tool.',
        inputSchema: {
            beforeUrl: z.string().url().describe('Legacy page URL to open in Edge IE mode'),
            afterUrl: z.string().url().describe('Migrated page URL to open in Chromium Edge'),
            width: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('CSS viewport width; default 1440'),
            height: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('CSS viewport height; default 900'),
            beforeOptions: browserOptionsSchema,
            afterOptions: browserOptionsSchema,
        },
    },
    async ({ beforeUrl, afterUrl, width = 1440, height = 900, beforeOptions, afterOptions }) => {
        const startedSessions = [];
        try {
            const launches = await Promise.allSettled([
                launchBrowser('edge-ie', beforeOptions),
                launchBrowser('edge', afterOptions),
            ]);
            for (const launch of launches) {
                if (launch.status === 'fulfilled') startedSessions.push(launch.value);
            }
            const failedLaunch = launches.find((launch) => launch.status === 'rejected');
            if (failedLaunch) throw failedLaunch.reason;
            const [before, after] = launches.map((launch) => launch.value);

            await Promise.all([before.driver.get(beforeUrl), after.driver.get(afterUrl)]);
            await Promise.all([
                ensureViewport(before.driver, width, height),
                ensureViewport(after.driver, width, height),
            ]);

            const result = {
                beforeSessionId: before.sessionId,
                afterSessionId: after.sessionId,
                captureContract: {
                    width,
                    height,
                    mode: 'viewport',
                    browserChrome: false,
                    scrollX: 0,
                    scrollY: 0,
                    allowImageResize: false,
                },
                warnings: [...before.warnings, ...after.warnings],
            };
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            await cleanUpSessions(startedSessions);
            return {
                content: [{ type: 'text', text: `Error starting VRT browsers: ${e.message}` }],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'vrt',
    {
        description:
            'Captures the current page viewport from two Selenium sessions and compares the PNG files with Playwright Test. Operate each session into the equivalent UI state before calling this tool.',
        inputSchema: {
            beforeSessionId: z.string().describe('Session ID containing the expected IE view'),
            afterSessionId: z.string().describe('Session ID containing the migrated Edge view'),
            name: z.string().describe('Stable screen or checkpoint name used for artifacts'),
            width: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('CSS viewport width; default 1440'),
            height: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('CSS viewport height; default 900'),
            maxDiffPixelRatio: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe('Maximum changed-pixel ratio; default 0.005'),
            threshold: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe('Per-pixel color difference threshold; default 0.2'),
        },
    },
    async ({
        beforeSessionId,
        afterSessionId,
        name,
        width = 1440,
        height = 900,
        maxDiffPixelRatio = 0.005,
        threshold = 0.2,
    }) => {
        try {
            if (beforeSessionId === afterSessionId) {
                throw new Error('beforeSessionId and afterSessionId must be different');
            }
            const beforeDriver = getDriver(beforeSessionId);
            const afterDriver = getDriver(afterSessionId);
            await Promise.all([
                ensureViewport(beforeDriver, width, height),
                ensureViewport(afterDriver, width, height),
            ]);

            const [beforePng, afterPng] = await Promise.all([
                beforeDriver.takeScreenshot(),
                afterDriver.takeScreenshot(),
            ]);
            const beforeSize = pngDimensions(beforePng);
            const afterSize = pngDimensions(afterPng);
            if (
                beforeSize.width !== afterSize.width ||
                beforeSize.height !== afterSize.height ||
                beforeSize.width !== width ||
                beforeSize.height !== height
            ) {
                throw new Error(
                    `Capture contract mismatch: expected ${width}x${height}, before is ${beforeSize.width}x${beforeSize.height}, after is ${afterSize.width}x${afterSize.height}. Images were not resized.`
                );
            }

            const artifactRoot = resolve(
                process.env.MCP_VRT_ARTIFACT_DIR || join(process.cwd(), 'artifacts', 'vrt')
            );
            const runDirectory = join(
                artifactRoot,
                safeArtifactName(name),
                new Date().toISOString().replace(/[:.]/g, '-')
            );
            const baselineDirectory = join(runDirectory, 'baseline');
            await mkdir(baselineDirectory, { recursive: true });
            const beforePath = join(runDirectory, 'before.png');
            const afterPath = join(runDirectory, 'after.png');
            const expectedPath = join(baselineDirectory, 'expected.png');
            await Promise.all([
                writeFile(beforePath, beforePng, 'base64'),
                writeFile(afterPath, afterPng, 'base64'),
            ]);
            await copyFile(beforePath, expectedPath);

            const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
            const configPath = join(packageRoot, 'src', 'vrt', 'playwright.config.js');
            const playwrightCli = join(
                packageRoot,
                'node_modules',
                '@playwright',
                'test',
                'cli.js'
            );
            let status = 'passed';
            let runnerOutput = '';
            try {
                const { stdout, stderr } = await execFileAsync(
                    process.execPath,
                    [playwrightCli, 'test', '--config', configPath],
                    {
                        cwd: packageRoot,
                        env: {
                            ...process.env,
                            MCP_VRT_RUN_DIR: runDirectory,
                            MCP_VRT_ACTUAL_PATH: afterPath,
                            MCP_VRT_MAX_DIFF_PIXEL_RATIO: String(maxDiffPixelRatio),
                            MCP_VRT_THRESHOLD: String(threshold),
                        },
                        maxBuffer: 10 * 1024 * 1024,
                    }
                );
                runnerOutput = `${stdout}\n${stderr}`.trim();
            } catch (runnerError) {
                status = 'different';
                runnerOutput = `${runnerError.stdout || ''}\n${runnerError.stderr || ''}`.trim();
                if (!runnerOutput) runnerOutput = runnerError.message;
            }

            let diffPath;
            try {
                diffPath = await findDiffImage(join(runDirectory, 'test-results'));
            } catch (_) {
                // A passing comparison does not generate a diff image.
            }
            const result = {
                status,
                name,
                capture: { width, height, browserChrome: false, resized: false },
                comparison: { maxDiffPixelRatio, threshold },
                artifacts: {
                    runDirectory,
                    before: beforePath,
                    after: afterPath,
                    diff: diffPath,
                    report: join(runDirectory, 'report.json'),
                },
                playwrightOutput: runnerOutput,
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error running VRT: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// Resources
server.registerResource(
    'browser-status',
    'browser-status://current',
    {
        description: 'Current browser session status',
        mimeType: 'text/plain',
    },
    async (uri) => ({
        contents: [
            {
                uri: uri.href,
                mimeType: 'text/plain',
                text: state.currentSession
                    ? `Active browser session: ${state.currentSession}`
                    : 'No active browser session',
            },
        ],
    })
);

server.registerResource(
    'accessibility-snapshot',
    'accessibility://current',
    {
        description:
            'Accessibility tree snapshot of the current page. A compact, structured representation of interactive elements and text content, much smaller than full HTML. Useful for understanding page layout and finding elements to interact with.',
        mimeType: 'application/json',
    },
    async (uri) => {
        try {
            const driver = state.drivers.get(state.currentSession);
            //-32002 is not in the SDK but is noted in the MCP specification:
            // https://modelcontextprotocol.io/specification/2025-11-25/server/resources#error-handling
            if (!driver)
                throw new McpError(-32002, 'No active browser session. Start a browser first.');
            const tree = (await driver.executeScript(accessibilitySnapshotScript)) || {};
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: 'application/json',
                        text: JSON.stringify(tree, null, 2),
                    },
                ],
            };
        } catch (e) {
            if (e instanceof McpError) throw e;
            throw new McpError(
                ErrorCode.InternalError,
                `Failed to capture accessibility snapshot: ${e.message}`
            );
        }
    }
);

// Cleanup handler
async function cleanup() {
    for (const [sessionId, driver] of state.drivers) {
        try {
            await driver.quit();
        } catch (e) {
            console.error(`Error closing browser session ${sessionId}:`, e);
        }
    }
    state.drivers.clear();
    state.bidi.clear();
    state.currentSession = null;
    process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
