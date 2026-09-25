# Apple Foundation Models Chat Provider

This companion VS Code extension adds Apple's on-device Foundation Model to the VS Code chat model picker. It reuses the Swift helper bundled with `boylett.on-device-model`; that extension's own chat sidebar continues to work unchanged.

Requirements:

- VS Code 1.139 or newer
- macOS 26 or newer on Apple Silicon
- Apple Intelligence enabled and its on-device model available
- The `boylett.on-device-model` extension installed

Build and install the companion extension:

```sh
npm install
npm run typecheck
npm run package
code --install-extension apple-foundation-models-chat-provider-0.1.0.vsix
```

Reload VS Code, open Copilot Chat, and select **Apple Foundation Models (On-Device)** from the model picker. This provider supports text chat only; tool calling and image input are not advertised.

Before publishing to the VS Code Marketplace, replace the local `publisher` value in `package.json` with your registered Marketplace publisher ID.