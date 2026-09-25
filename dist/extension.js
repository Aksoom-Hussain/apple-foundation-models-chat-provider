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
const ON_DEVICE_MODEL_EXTENSION = "boylett.on-device-model";
const MODEL_INFO = {
    id: MODEL_ID,
    name: "Apple Foundation Models (On-Device)",
    family: "apple-foundation-models",
    version: "1",
    maxInputTokens: 4096,
    maxOutputTokens: 1024,
    capabilities: { toolCalling: false },
};
function activate(context) {
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, new AppleFoundationModelProvider()));
}
class AppleFoundationModelProvider {
    async provideLanguageModelChatInformation() {
        const helperPath = getHelperPath();
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
    async provideLanguageModelChatResponse(_model, messages, _options, progress, token) {
        const helperPath = getHelperPath();
        if (!helperPath) {
            throw new Error(`Install the ${ON_DEVICE_MODEL_EXTENSION} extension to use this model.`);
        }
        const prompt = messages
            .map((message) => {
            const role = message.role === vscode.LanguageModelChatMessageRole.Assistant
                ? "Assistant"
                : "User";
            return `${role}: ${message.content.map(readTextPart).filter(Boolean).join("")}`;
        })
            .join("\n\n");
        await requestModel(helperPath, prompt, progress, token);
    }
    async provideTokenCount(_model, text, _token) {
        const value = typeof text === "string"
            ? text
            : text.content.map(readTextPart).filter(Boolean).join("");
        return Math.ceil(value.length / 4);
    }
}
function getHelperPath() {
    if (process.platform !== "darwin" || process.arch !== "arm64") {
        return undefined;
    }
    const extension = vscode.extensions.getExtension(ON_DEVICE_MODEL_EXTENSION);
    return extension
        ? (0, node_path_1.join)(extension.extensionPath, "dist", "bin", "on-device-model-cli")
        : undefined;
}
function readTextPart(part) {
    if (typeof part !== "object" || part === null || !("value" in part)) {
        return "";
    }
    return typeof part.value === "string" ? part.value : "";
}
function requestModel(helperPath, prompt, progress, token) {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const child = (0, node_child_process_1.spawn)(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
        let stdoutBuffer = "";
        let stderr = "";
        let responseStarted = false;
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
                        child.stdin.write(`${JSON.stringify({ type: "prompt", id: requestId, text: prompt })}\n`);
                    }
                }
                else if (event.type === "chunk" && event.id === requestId && event.delta) {
                    progress.report(new vscode.LanguageModelTextPart(event.delta));
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
                const details = stderr.trim();
                finish(new Error(details || `Apple model helper exited with code ${code ?? "unknown"}.`));
            }
        });
    });
}
