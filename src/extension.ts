import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";

const VENDOR = "apple-foundation-models";
const MODEL_ID = "apple-foundation-model";
const MODEL_INFO: vscode.LanguageModelChatInformation = {
	id: MODEL_ID,
	name: "AFM # Chat Provider",
	family: "apple-foundation-models",
	version: "1",
	maxInputTokens: 16_384,
	maxOutputTokens: 1024,
	detail: "4K on-device context; older conversation and excess tools are trimmed automatically.",
	capabilities: { toolCalling: true },
};

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider(
			VENDOR,
			new AppleFoundationModelProvider(context.extensionUri.fsPath),
		),
	);
}

class AppleFoundationModelProvider implements vscode.LanguageModelChatProvider {
	constructor(private readonly extensionPath: string) {}

	async provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
		const helperPath = getHelperPath(this.extensionPath);
		if (!helperPath) {
			return [];
		}

		try {
			await access(helperPath, constants.X_OK);
			return [MODEL_INFO];
		} catch {
			return [];
		}
	}

	async provideLanguageModelChatResponse(
		_model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
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

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		const value = typeof text === "string"
			? text
			: text.content.map(readTextPart).filter(Boolean).join("");
		return Math.ceil(value.length / 4);
	}
}

function getHelperPath(extensionPath: string): string | undefined {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		return undefined;
	}

	return join(extensionPath, "dist", "bin", "on-device-model-cli");
}

function readTextPart(part: unknown): string {
	if (typeof part !== "object" || part === null || !("value" in part)) {
		return "";
	}

	return typeof part.value === "string" ? part.value : "";
}

function getExecutedToolCalls(messages: readonly vscode.LanguageModelChatRequestMessage[]): Set<string> {
	const set = new Set<string>();
	for (const msg of messages) {
		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				set.add(`${part.name}:${JSON.stringify(part.input)}`);
			}
		}
	}
	return set;
}

function shouldEnableTools(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions,
): boolean {
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

function serializeMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
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

function sanitizeTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): unknown[] {
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

function sanitizeSchema(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null) {
		return { type: "string" };
	}

	const obj = schema as Record<string, unknown>;
	const type = typeof obj.type === "string" ? obj.type : undefined;

	if (type === "object" || obj.properties) {
		const properties = (typeof obj.properties === "object" && obj.properties !== null)
			? obj.properties as Record<string, unknown>
			: {};
		const sanitizedProps: Record<string, unknown> = {};
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

function requestModel(
	helperPath: string,
	prompt: string,
	options: vscode.ProvideLanguageModelChatResponseOptions,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	token: vscode.CancellationToken,
	executedTools?: Set<string>,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const requestId = crypto.randomUUID();
		const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
		let stdoutBuffer = "";
		let stderr = "";
		let responseStarted = false;
		let toolCallCount = 0;
		let settled = false;
		let cancellation: vscode.Disposable | undefined;

		const finish = (error?: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			cancellation?.dispose();
			child.kill();
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};

		cancellation = token.onCancellationRequested(() => {
			child.stdin.write(`${JSON.stringify({ type: "cancel", id: requestId })}\n`);
			finish(new vscode.CancellationError());
		});

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-2000);
		});
		child.stdout.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (settled || line.trim().length === 0) {
					continue;
				}

				let event: HelperEvent;
				try {
					event = JSON.parse(line) as HelperEvent;
				} catch {
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
				} else if (event.type === "chunk" && event.id === requestId && event.delta) {
					progress.report(new vscode.LanguageModelTextPart(event.delta));
				} else if (event.type === "toolCall" && event.id === requestId && event.callId && event.name) {
					try {
						const input: unknown = JSON.parse(event.input ?? "{}");
						if (typeof input !== "object" || input === null || Array.isArray(input)) {
							throw new Error("Tool arguments must be a JSON object.");
						}
						const key = `${event.name}:${JSON.stringify(input)}`;
						if (executedTools?.has(key)) {
							// Circuit breaker: duplicate tool call detected. Fallback to response generation without tools.
							settled = true;
							cancellation?.dispose();
							child.kill();
							requestModel(
								helperPath,
								prompt + "\n\nSystem: Summarize the final answer for the user based on the tool results.",
								{ ...options, tools: [] },
								progress,
								token,
							).then(resolve, reject);
							return;
						}
						toolCallCount++;
						progress.report(new vscode.LanguageModelToolCallPart(event.callId, event.name, input));
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
						return;
					}
				} else if (event.type === "done" && event.id === requestId) {
					finish();
				} else if (event.type === "error" && event.id === requestId) {
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

type HelperEvent =
	| { type: "ready"; available: boolean; reason?: string }
	| { type: "chunk"; id: string; delta: string }
	| { type: "toolCall"; id: string; callId: string; name: string; input: string }
	| { type: "done"; id: string; content: string }
	| { type: "error"; id: string; message: string };