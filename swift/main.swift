import Foundation
import FoundationModels

struct Request: Decodable {
    let type: String
    let id: String?
    let text: String?
}

struct Event: Encodable {
    let type: String
    var available: Bool? = nil
    var reason: String? = nil
    var id: String? = nil
    var delta: String? = nil
    var content: String? = nil
    var message: String? = nil
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

        do {
            let response = try await LanguageModelSession().respond(to: prompt)
            emit(Event(type: "chunk", id: requestID, delta: response.content))
            emit(Event(type: "done", id: requestID, content: response.content))
        } catch {
            emit(Event(type: "error", id: requestID, message: error.localizedDescription))
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