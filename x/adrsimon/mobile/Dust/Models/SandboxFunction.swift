import Foundation

struct SandboxFunctionCallError: Codable, Error {
    let code: String
    let message: String
    var status: Int?

    static func transport(_ message: String) -> SandboxFunctionCallError {
        SandboxFunctionCallError(code: "transport_error", message: message)
    }

    static func notSupported(_ message: String) -> SandboxFunctionCallError {
        SandboxFunctionCallError(code: "not_supported", message: message)
    }
}

struct SandboxFunctionInvocationRequest: Encodable {
    struct Context: Encodable {
        let timezone: String
    }

    let input: JSONValue?
    let context: Context
}

struct SandboxFunctionInvocation: Decodable {
    let sId: String
    let functionId: String
}

enum SandboxFunctionInvocationOutcome: Decodable {
    case succeeded(JSONValue?)
    case errored(SandboxFunctionCallError)

    private enum CodingKeys: String, CodingKey {
        case status, result, error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let status = try container.decode(String.self, forKey: .status)
        switch status {
        case "succeeded":
            self = try .succeeded(container.decodeIfPresent(JSONValue.self, forKey: .result))
        case "errored":
            self = try .errored(container.decode(SandboxFunctionCallError.self, forKey: .error))
        default:
            self = .errored(.transport("Unsupported function invocation outcome."))
        }
    }
}

struct SandboxFunctionInvocationResponse: Decodable {
    let invocation: SandboxFunctionInvocation
    let outcome: SandboxFunctionInvocationOutcome?
}

struct SandboxFunctionApproveExecutionEvent: Decodable {
    let actionId: String
    let sandboxFunctionId: String
    let invocationId: String
    let stake: String?
    let metadata: ToolApprovalMetadata?
    let inputs: [String: ToolInputValue]?
}

struct SandboxFunctionPersonalAuthRequiredEvent: Decodable {
    let actionId: String
    let sandboxFunctionId: String
    let invocationId: String
    let authError: ToolPersonalAuthError
}

enum SandboxFunctionInvocationEvent: Decodable {
    case result(JSONValue?)
    case error(SandboxFunctionCallError)
    case approveExecution(SandboxFunctionApproveExecutionEvent)
    case personalAuthRequired(SandboxFunctionPersonalAuthRequiredEvent)
    case other

    private enum CodingKeys: String, CodingKey {
        case type, result, error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "sandbox_function_invocation_result":
            self = try .result(container.decodeIfPresent(JSONValue.self, forKey: .result))
        case "sandbox_function_invocation_error":
            self = try .error(container.decode(SandboxFunctionCallError.self, forKey: .error))
        case "tool_approve_execution":
            self = try .approveExecution(SandboxFunctionApproveExecutionEvent(from: decoder))
        case "tool_personal_auth_required":
            self = try .personalAuthRequired(SandboxFunctionPersonalAuthRequiredEvent(from: decoder))
        default:
            self = .other
        }
    }
}

struct SandboxFunctionInvocationEventEnvelope: Decodable {
    let eventId: String
    let data: SandboxFunctionInvocationEvent
}

struct SandboxFunctionValidateActionRequest: Encodable {
    let approved: String
}

struct SandboxFunctionAuthResolution: Encodable {
    let outcome: String = "denied"
}

struct FrameFunctionApproval: Identifiable {
    let functionId: String
    let invocationId: String
    let actionId: String
    let prompt: ToolApprovalPrompt

    var id: String {
        actionId
    }

    init(from event: SandboxFunctionApproveExecutionEvent) {
        self.functionId = event.sandboxFunctionId
        self.invocationId = event.invocationId
        self.actionId = event.actionId
        self.prompt = ToolApprovalPrompt(
            toolName: event.metadata?.toolName,
            mcpServerName: event.metadata?.mcpServerName,
            stake: event.stake.flatMap(ToolStake.init(rawValue:)),
            inputs: event.inputs
        )
    }
}
