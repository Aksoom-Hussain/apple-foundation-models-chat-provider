import Foundation
import FoundationModels

struct Request: Decodable {
    let type: String
    let id: String?
    let text: String?
    let tools: [ToolDefinition]?
    let toolMode: String?
}

struct ToolDefinition: Decodable, Sendable {
    let name: String
    let description: String
    let inputSchema: JSONValue?
}

indirect enum JSONValue: Decodable, Sendable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case boolean(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.typeMismatch(
                JSONValue.self,
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Unsupported JSON value"),
            )
        }
    }

    var objectValue: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    var arrayValue: [JSONValue]? {
        guard case .array(let value) = self else { return nil }
        return value
    }

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }
}

struct CapturedToolCall: Sendable {
    let callId: String
    let name: String
    let input: String
}

actor ToolCallCapture {
    private var calls: [CapturedToolCall] = []

    func append(_ call: CapturedToolCall) {
        calls.append(call)
    }

    func drain() -> [CapturedToolCall] {
        defer { calls.removeAll() }
        return calls
    }
}

struct ToolCallForwarded: Error, Sendable {}

struct VSCodeTool: Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String

    let name: String
    let description: String
    let parameters: GenerationSchema
    let capture: ToolCallCapture

    func call(arguments: GeneratedContent) async throws -> String {
        await capture.append(CapturedToolCall(
            callId: UUID().uuidString,
            name: name,
            input: arguments.jsonString,
        ))
        throw ToolCallForwarded()
    }
}

struct Event: Encodable {
    let type: String
    var available: Bool? = nil
    var reason: String? = nil
    var id: String? = nil
    var delta: String? = nil
    var content: String? = nil
    var message: String? = nil
    var callId: String? = nil
    var name: String? = nil
    var input: String? = nil
}

@main
struct OnDeviceModelCLI {
    static func main() async {
        switch SystemLanguageModel.default.availability {
        case .available:
            emit(Event(type: "ready", available: true))
        case .unavailable(let reason):
            emit(Event(type: "ready", available: false, reason: String(describing: reason)))
            return
        @unknown default:
            emit(Event(type: "ready", available: false, reason: "unknown availability"))
            return
        }

        guard let line = readLine(),
              let requestData = line.data(using: .utf8),
              let request = try? JSONDecoder().decode(Request.self, from: requestData),
              request.type == "prompt",
              let requestID = request.id,
              let prompt = request.text else {
            return
        }

        let capture = ToolCallCapture()
        do {
            let tools = try (request.tools ?? []).map { try makeTool($0, capture: capture) }
            let session = LanguageModelSession(tools: tools)
            let response = try await respond(session: session, prompt: prompt, toolMode: request.toolMode)
            emit(Event(type: "chunk", id: requestID, delta: response))
            emit(Event(type: "done", id: requestID, content: response))
        } catch {
            let calls = await capture.drain()
            if calls.isEmpty {
                emit(Event(type: "error", id: requestID, message: error.localizedDescription))
            } else {
                for call in calls {
                    emit(Event(
                        type: "toolCall",
                        id: requestID,
                        callId: call.callId,
                        name: call.name,
                        input: call.input,
                    ))
                }
            }
        }
    }

    private static func makeTool(_ definition: ToolDefinition, capture: ToolCallCapture) throws -> VSCodeTool {
        let schema = try generationSchema(
            definition.inputSchema ?? .object(["type": .string("object")]),
            name: "Arguments",
        )
        return VSCodeTool(
            name: definition.name,
            description: definition.description,
            parameters: try GenerationSchema(root: schema, dependencies: []),
            capture: capture,
        )
    }

    private static func respond(session: LanguageModelSession, prompt: String, toolMode: String?) async throws -> String {
        if toolMode == "required" {
            guard #available(macOS 27.0, *) else {
                throw ToolSchemaError.requiredModeUnavailable
            }
            return try await session.respond(
                to: prompt,
                options: GenerationOptions(toolCallingMode: .required),
            ).content
        }
        return try await session.respond(to: prompt).content
    }

    private static func generationSchema(_ value: JSONValue, name: String) throws -> DynamicGenerationSchema {
        let schema = value.objectValue ?? [:]
        let description = schema["description"]?.stringValue
        switch schema["type"]?.stringValue {
        case "object":
            let properties = schema["properties"]?.objectValue ?? [:]
            let required = Set(schema["required"]?.arrayValue?.compactMap(\.stringValue) ?? [])
            let generatedProperties = try properties.map { propertyName, propertySchema in
                DynamicGenerationSchema.Property(
                    name: propertyName,
                    description: propertySchema.objectValue?["description"]?.stringValue,
                    schema: try generationSchema(propertySchema, name: propertyName),
                    isOptional: !required.contains(propertyName),
                )
            }
            return DynamicGenerationSchema(name: name, description: description, properties: generatedProperties)
        case "array":
            guard let itemSchema = schema["items"] else {
                throw ToolSchemaError.missingArrayItems(name)
            }
            return DynamicGenerationSchema(arrayOf: try generationSchema(itemSchema, name: "Item"))
        case "string":
            if let values = schema["enum"]?.arrayValue?.compactMap(\.stringValue), !values.isEmpty {
                return DynamicGenerationSchema(name: name, description: description, anyOf: values)
            }
            return DynamicGenerationSchema(type: String.self)
        case "integer":
            return DynamicGenerationSchema(type: Int.self)
        case "number":
            return DynamicGenerationSchema(type: Double.self)
        case "boolean":
            return DynamicGenerationSchema(type: Bool.self)
        default:
            throw ToolSchemaError.unsupportedType(name, schema["type"]?.stringValue)
        }
    }

    private static func emit(_ event: Event) {
        guard let data = try? JSONEncoder().encode(event) else {
            return
        }

        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

enum ToolSchemaError: LocalizedError {
    case missingArrayItems(String)
    case unsupportedType(String, String?)
    case requiredModeUnavailable

    var errorDescription: String? {
        switch self {
        case .missingArrayItems(let name):
            return "The tool schema for \(name) is missing its array item schema."
        case .unsupportedType(let name, let type):
            return "The tool schema for \(name) uses an unsupported type: \(type ?? "unknown")."
        case .requiredModeUnavailable:
            return "Required tool calling needs macOS 27 or newer."
        }
    }
}