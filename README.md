# AFM # Chat Provider

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
code --install-extension apple-foundation-models-chat-provider-darwin-arm64-0.1.4.vsix
```

Reload VS Code, open Copilot Chat, and select **AFM # Chat Provider** from the model picker. Tool calling is supported; image input is not advertised.

The Marketplace publisher ID is `aksoomhussain`.