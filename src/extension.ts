import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";

const VENDOR = "apple-foundation-models";
const MODEL_ID = "apple-foundation-model";
const ON_DEVICE_MODEL_EXTENSION = "boylett.on-device-model";
const MODEL_INFO: vscode.LanguageModelChatInformation = {
	id: MODEL_ID,
	name: "Apple Foundation Models (On-Device)",
	family: "apple-foundation-models",
	version: "1",
	maxInputTokens: 4096,
	maxOutputTokens: 1024,
	capabilities: { toolCalling: false },
};

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider(VENDOR, new AppleFoundationModelProvider()),
	);
}

class AppleFoundationModelProvider implements vscode.LanguageModelChatProvider {
	async provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
		const helperPath = getHelperPath();
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
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
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

function getHelperPath(): string | undefined {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		return undefined;
	}

	const extension = vscode.extensions.getExtension(ON_DEVICE_MODEL_EXTENSION);
	return extension
		? join(extension.extensionPath, "dist", "bin", "on-device-model-cli")
		: undefined;
}

function readTextPart(part: unknown): string {
	if (typeof part !== "object" || part === null || !("value" in part)) {
		return "";
	}

	return typeof part.value === "string" ? part.value : "";
}

function requestModel(
	helperPath: string,
	prompt: string,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	token: vscode.CancellationToken,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const requestId = crypto.randomUUID();
		const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
		let stdoutBuffer = "";
		let stderr = "";
		let responseStarted = false;
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
						child.stdin.write(`${JSON.stringify({ type: "prompt", id: requestId, text: prompt })}\n`);
					}
				} else if (event.type === "chunk" && event.id === requestId && event.delta) {
					progress.report(new vscode.LanguageModelTextPart(event.delta));
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
				const details = stderr.trim();
				finish(new Error(details || `Apple model helper exited with code ${code ?? "unknown"}.`));
			}
		});
	});
}

type HelperEvent =
	| { type: "ready"; available: boolean; reason?: string }
	| { type: "chunk"; id: string; delta: string }
	| { type: "done"; id: string; content: string }
	| { type: "error"; id: string; message: string };