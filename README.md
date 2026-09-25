# Apple Foundation Models Chat Provider

This VS Code extension adds Apple's on-device Foundation Model to the VS Code chat model picker. It includes and builds its own Swift helper using Apple's Foundation Models framework.

Requirements:

- VS Code 1.139 or newer
- macOS 26 or newer on Apple Silicon
- Apple Intelligence enabled and its on-device model available
- Xcode Command Line Tools with Swift and the macOS SDK

Build and install the companion extension:

```sh
npm install
npm run typecheck
npm run build
npm run package
code --install-extension apple-foundation-models-chat-provider-0.1.0-darwin-arm64.vsix
```

Reload VS Code, open Copilot Chat, and select **Apple Foundation Models (On-Device)** from the model picker. This provider supports text chat only; tool calling and image input are not advertised.

Before publishing to the VS Code Marketplace, replace the local `publisher` value in `package.json` with your registered Marketplace publisher ID.