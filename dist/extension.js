"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const vscode = __importStar(require("vscode"));
const VENDOR = "apple-foundation-models";
const MODEL_ID = "apple-foundation-model";
const MODEL_INFO = {
    id: MODEL_ID,
    name: "AFM # Chat Provider",
    family: "apple-foundation-models",
    version: "1",
    maxInputTokens: 16_384,
    maxOutputTokens: 1024,
    detail: "4K on-device context; older conversation and excess tools are trimmed automatically.",
    capabilities: { toolCalling: true },
};
function activate(context) {
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, new AppleFoundationModelProvider(context.extensionUri.fsPath)));
}
class AppleFoundationModelProvider {
    extensionPath;
    constructor(extensionPath) {
        this.extensionPath = extensionPath;
    }
    async provideLanguageModelChatInformation() {
        const helperPath = getHelperPath(this.extensionPath);
        if (!helperPath) {
            return [];
        }
        try {
            await (0, promises_1.access)(helperPath, node_fs_1.constants.X_OK);
            return [MODEL_INFO];
        }
        catch {
            return [];
        }
    }
    async provideLanguageModelChatResponse(_model, messages, options, progress, token) {
        const helperPath = getHelperPath(this.extensionPath);
        if (!helperPath) {
            throw new Error("Apple Foundation Models is supported only on macOS with Apple Silicon.");
        }
        const executedTools = getExecutedToolCalls(messages);
        const enableTools = shouldEnableTools(messages, options);
        const effectiveOptions = enableTools ? options : { ...options, tools: [] };
        const prompt = serializeMessages(messages);
        await requestModel(helperPath, prompt, effectiveOptions, progress, token, executedTools);
    }
    async provideTokenCount(_model, text, _token) {
        const value = typeof text === "string"
            ? text
            : text.content.map(readTextPart).filter(Boolean).join("");
        return Math.ceil(value.length / 4);
    }
}
function getHelperPath(extensionPath) {
    if (process.platform !== "darwin" || process.arch !== "arm64") {
        return undefined;
    }
    return (0, node_path_1.join)(extensionPath, "dist", "bin", "on-device-model-cli");
}
function readTextPart(part) {
    if (typeof part !== "object" || part === null || !("value" in part)) {
        return "";
    }
    return typeof part.value === "string" ? part.value : "";
}
function getExecutedToolCalls(messages) {
    const set = new Set();
    for (const msg of messages) {
        for (const part of msg.content) {
            if (part instanceof vscode.LanguageModelToolCallPart) {
                set.add(`${part.name}:${JSON.stringify(part.input)}`);
            }
        }
    }
    return set;
}
function shouldEnableTools(messages, options) {
    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
        return true;
    }
    if (!options.tools || options.tools.length === 0) {
        return false;
    }
    for (const msg of messages) {
        for (const part of msg.content) {
            if (part instanceof vscode.LanguageModelToolCallPart || part instanceof vscode.LanguageModelToolResultPart) {
                return false;
            }
        }
    }
    const fullUserText = messages
        .filter((m) => m.role === vscode.LanguageModelChatMessageRole.User)
        .map((m) => m.content.map(readTextPart).join(" "))
        .join("\n")
        .toLowerCase();
    const mathRegex = /^\s*[\d\s\+\-\*\/\^\(\)\.\=\%]+\s*$/;
    if (mathRegex.test(fullUserText)) {
        return false;
    }
    const commonShortGreetings = new Set([
        "hi", "hello", "hey", "good morning", "good afternoon", "good evening",
        "who are you", "what can you do", "help", "test", "ping", "1+1", "1+2"
    ]);
    if (commonShortGreetings.has(fullUserText.trim().replace(/[!\?\.]/g, ""))) {
        return false;
    }
    const workspaceKeywords = [
        "file", "files", "read", "search", "find", "grep", "lookup", "code", "repo",
        "workspace", "directory", "folder", "project", "fix", "edit", "update", "modify",
        "refactor", "function", "class", "method", "bug", "error", "terminal", "run",
        "git", "diff", "path", "src", "dist", "index", "readme", "package", "config",
        "open", "where", "how does", "what does", "implement", "add", "create", "delete",
        "/fix", "/explain", "/tests", "@workspace"
    ];
    const hasWorkspaceKeyword = workspaceKeywords.some((kw) => fullUserText.includes(kw));
    const hasPathOrExt = /[\w\-\.\/]+\.(ts|js|jsx|tsx|py|swift|json|md|html|css|scss|php|c|cpp|h|java|go|rs|sh|yaml|yml)/i.test(fullUserText);
    return hasWorkspaceKeyword || hasPathOrExt;
}
function serializeMessages(messages) {
    let hasToolResult = false;
    const body = messages.map((message) => {
        const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? "Assistant" : "User";
        const content = message.content.map((part) => {
            if (part instanceof vscode.LanguageModelToolCallPart) {
                return `[Requested tool '${part.name}' (${part.callId}) with input: ${JSON.stringify(part.input)}]`;
            }
            if (part instanceof vscode.LanguageModelToolResultPart) {
                hasToolResult = true;
                const text = part.content.map(readTextPart).filter(Boolean).join("");
                return `[Tool '${part.callId}' result: ${text || "No output / no matches"}]`;
            }
            return readTextPart(part);
        }).filter(Boolean).join("");
        return `${role}: ${content}`;
    }).join("\n\n");
    const systemHeader = "System: You are an AI assistant in VS Code. Answer general questions, math, and conversational prompts directly. Only invoke tools if inspecting or searching workspace files is required.";
    if (hasToolResult) {
        return `${systemHeader}\n\n${body}\n\nSystem: Answer the user's request clearly and concisely. Use the tool results above if relevant, or answer directly.`;
    }
    return `${systemHeader}\n\n${body}`;
}
function sanitizeTools(tools) {
    if (!tools) {
        return [];
    }
    return tools.map((tool) => {
        const inputSchema = tool.inputSchema ? sanitizeSchema(tool.inputSchema) : { type: "object" };
        return {
            name: tool.name,
            description: tool.description,
            inputSchema,
        };
    });
}
function sanitizeSchema(schema) {
    if (typeof schema !== "object" || schema === null) {
        return { type: "string" };
    }
    const obj = schema;
    const type = typeof obj.type === "string" ? obj.type : undefined;
    if (type === "object" || obj.properties) {
        const properties = (typeof obj.properties === "object" && obj.properties !== null)
            ? obj.properties
            : {};
        const sanitizedProps = {};
        for (const [key, prop] of Object.entries(properties)) {
            sanitizedProps[key] = sanitizeSchema(prop);
        }
        return {
            ...obj,
            type: "object",
            properties: sanitizedProps,
        };
    }
    if (type === "array" || obj.items) {
        return {
            ...obj,
            type: "array",
            items: sanitizeSchema(obj.items ?? { type: "string" }),
        };
    }
    if (type === "integer" || type === "number" || type === "boolean" || type === "string") {
        return obj;
    }
    return {
        ...obj,
        type: "string",
    };
}
function requestModel(helperPath, prompt, options, progress, token, executedTools) {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const child = (0, node_child_process_1.spawn)(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
        let stdoutBuffer = "";
        let stderr = "";
        let responseStarted = false;
        let toolCallCount = 0;
        let settled = false;
        let cancellation;
        const finish = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            cancellation?.dispose();
            child.kill();
            if (error) {
                reject(error);
            }
            else {
                resolve();
            }
        };
        cancellation = token.onCancellationRequested(() => {
            child.stdin.write(`${JSON.stringify({ type: "cancel", id: requestId })}\n`);
            finish(new vscode.CancellationError());
        });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr = `${stderr}${chunk}`.slice(-2000);
        });
        child.stdout.on("data", (chunk) => {
            stdoutBuffer += chunk;
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";
            for (const line of lines) {
                if (settled || line.trim().length === 0) {
                    continue;
                }
                let event;
                try {
                    event = JSON.parse(line);
                }
                catch {
                    finish(new Error("The Apple model helper returned invalid output."));
                    return;
                }
                if (event.type === "ready") {
                    if (!event.available) {
                        finish(new Error(`Apple Foundation Models is unavailable: ${event.reason ?? "check Apple Intelligence settings"}.`));
                        return;
                    }
                    if (!responseStarted) {
                        responseStarted = true;
                        child.stdin.write(`${JSON.stringify({
                            type: "prompt",
                            id: requestId,
                            text: prompt,
                            tools: sanitizeTools(options.tools),
                            toolMode: options.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto",
                        })}\n`);
                    }
                }
                else if (event.type === "chunk" && event.id === requestId && event.delta) {
                    progress.report(new vscode.LanguageModelTextPart(event.delta));
                }
                else if (event.type === "toolCall" && event.id === requestId && event.callId && event.name) {
                    try {
                        const input = JSON.parse(event.input ?? "{}");
                        if (typeof input !== "object" || input === null || Array.isArray(input)) {
                            throw new Error("Tool arguments must be a JSON object.");
                        }
                        const key = `${event.name}:${JSON.stringify(input)}`;
                        if (executedTools?.has(key)) {
                            // Circuit breaker: duplicate tool call detected. Fallback to response generation without tools.
                            settled = true;
                            cancellation?.dispose();
                            child.kill();
                            requestModel(helperPath, prompt + "\n\nSystem: Summarize the final answer for the user based on the tool results.", { ...options, tools: [] }, progress, token).then(resolve, reject);
                            return;
                        }
                        toolCallCount++;
                        progress.report(new vscode.LanguageModelToolCallPart(event.callId, event.name, input));
                    }
                    catch (error) {
                        finish(error instanceof Error ? error : new Error(String(error)));
                        return;
                    }
                }
                else if (event.type === "done" && event.id === requestId) {
                    finish();
                }
                else if (event.type === "error" && event.id === requestId) {
                    finish(new Error(event.message));
                }
            }
        });
        child.on("error", (error) => finish(error));
        child.on("close", (code) => {
            if (!settled) {
                if (toolCallCount > 0) {
                    finish();
                    return;
                }
                const details = stderr.trim();
                finish(new Error(details || `Apple model helper exited with code ${code ?? "unknown"}.`));
            }
        });
    });
}
