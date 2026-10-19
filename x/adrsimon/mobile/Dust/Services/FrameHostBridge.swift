import Foundation
import os
import WebKit

private let logger = Logger(subsystem: AppConfig.bundleId, category: "FrameHost")

/**
 * @cc [owner:adrsimon,label:product] frame-host-no-file-writes
 * The bridge MUST NOT write files: it answers `getFile`, `getUserIdentity` and `callFunction` and
 * logs `setErrorMessage`. A `getFile` that cannot be resolved or fetched MUST answer a missing file
 * rather than an error, matching the web host.
 */
@MainActor
final class FrameHostBridge: NSObject, ObservableObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "frameHost"

    @Published private(set) var pendingApprovals: [FrameFunctionApproval] = []
    @Published private(set) var isValidatingAction = false

    private let workspaceId: String
    private let file: FileReference
    private let isFrameV2: Bool
    private let functionScope: FrameFunctionScope
    private let tokenProvider: TokenProvider
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var fileContext: Task<FrameFileContext, Never>?
    private var user: Task<DustUser?, Never>?
    private var functionCalls: [UUID: Task<FrameFunctionCallReply, Never>] = [:]

    init(workspaceId: String, file: FileReference, contentType: String, tokenProvider: TokenProvider) {
        self.workspaceId = workspaceId
        self.file = file
        self.isFrameV2 = Attachment.isFrameV2(contentType)
        self.functionScope = if case let .id(frameId) = file, isFrameV2 { .frameV2(frameId: frameId) } else { .legacy }
        self.tokenProvider = tokenProvider
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) async -> (Any?, String?) {
        guard let body = message.body as? String else { return (nil, "Invalid frame host message") }
        do {
            let request = try JSONDecoder().decode(FrameHostRequest.self, from: Data(body.utf8))
            return try await (handle(request), nil)
        } catch {
            logger.error("Frame host request failed: \(error)")
            return (nil, error.localizedDescription)
        }
    }

    private func handle(_ request: FrameHostRequest) async throws -> String? {
        switch request.command {
        case .callFunction:
            return try await encode(callFunction(request.functionName ?? "", input: request.input))
        case .getFile:
            return try await encode(loadFile(request.fileId))
        case .getUserIdentity:
            return try await encode(loadUserIdentity())
        case .setErrorMessage:
            logger.error("Frame reported an error: \(request.errorMessage ?? "unknown", privacy: .public)")
            return nil
        }
    }

    func validate(_ approved: ActionApproval) async {
        guard let approval = pendingApprovals.first else { return }
        isValidatingAction = true
        defer { isValidatingAction = false }
        do {
            try await SandboxFunctionService.validateAction(
                workspaceId: workspaceId,
                approval: approval,
                approved: approved,
                tokenProvider: tokenProvider
            )
            pendingApprovals.removeAll { $0.id == approval.id }
        } catch {
            logger.error("Frame function action validation failed: \(error)")
        }
    }

    func cancelFunctionCalls() {
        functionCalls.values.forEach { $0.cancel() }
        pendingApprovals = []
    }

    /**
     * @cc [owner:adrsimon,label:product;error-handling] frame-function-call-reply
     * A `callFunction` MUST answer exactly one of `result` or `error`, never a bridge failure. An
     * HTTP error MUST forward the API error type verbatim as `code` with its `status`; transport,
     * stream and parse failures MUST answer `transport_error`. Every error answer MUST be logged.
     */
    private func callFunction(_ functionName: String, input: JSONValue?) async -> FrameFunctionCallReply {
        let callId = UUID()
        let call = Task { await runFunction(functionName, input: input) }
        functionCalls[callId] = call
        defer { functionCalls[callId] = nil }

        let reply = await call.value
        if let error = reply.error {
            let code = error.code
            logger.error("Frame function \(functionName, privacy: .public) failed (\(code, privacy: .public))")
        }
        return reply
    }

    private func runFunction(_ functionName: String, input: JSONValue?) async -> FrameFunctionCallReply {
        let functionIdOrSlug: String
        switch functionScope.resolve(functionName) {
        case let .success(reference):
            functionIdOrSlug = reference
        case let .failure(error):
            return .failure(error)
        }

        do {
            let response = try await SandboxFunctionService.invoke(
                workspaceId: workspaceId,
                functionIdOrSlug: functionIdOrSlug,
                input: input,
                tokenProvider: tokenProvider
            )
            let outcome = if let outcome = response.outcome {
                outcome
            } else {
                try await awaitOutcome(response.invocation)
            }
            switch outcome {
            case let .succeeded(result):
                return .success(result)
            case let .errored(error):
                return .failure(error)
            }
        } catch let error as SandboxFunctionCallError {
            return .failure(error)
        } catch {
            return .failure(.transport(error.localizedDescription))
        }
    }

    /**
     * @cc [owner:adrsimon,label:product] frame-function-blocked-actions
     * A tool approval blocking an invocation MUST be shown to the user and resolved only by their
     * choice. A personal-auth block MUST be denied, since the app cannot connect accounts, so the
     * invocation settles instead of hanging. An invocation's pending approvals MUST be dropped once
     * it settles or its call is cancelled.
     */
    private func awaitOutcome(
        _ invocation: SandboxFunctionInvocation
    ) async throws -> SandboxFunctionInvocationOutcome {
        defer { pendingApprovals.removeAll { $0.invocationId == invocation.sId } }

        var lastEventId: String?
        while !Task.isCancelled {
            let events = SandboxFunctionService.events(
                workspaceId: workspaceId,
                functionId: invocation.functionId,
                invocationId: invocation.sId,
                lastEventId: lastEventId,
                tokenProvider: tokenProvider
            )
            for try await payload in events {
                let envelope = try decoder.decode(SandboxFunctionInvocationEventEnvelope.self, from: Data(payload.utf8))
                lastEventId = envelope.eventId
                switch envelope.data {
                case let .result(result):
                    return .succeeded(result)
                case let .error(error):
                    return .errored(error)
                case let .approveExecution(event):
                    pendingApprovals.append(FrameFunctionApproval(from: event))
                case let .personalAuthRequired(event):
                    logger.info("Denying \(event.authError.provider, privacy: .public) auth for a frame function")
                    try await SandboxFunctionService.denyAuthentication(
                        workspaceId: workspaceId,
                        event: event,
                        tokenProvider: tokenProvider
                    )
                case .other:
                    continue
                }
            }
        }
        throw SandboxFunctionCallError.transport("The function call was cancelled.")
    }

    private func loadFile(_ frameFileId: String?) async -> FrameFilePayload {
        guard let frameFileId, let reference = await context().reference(for: frameFileId) else {
            return .missing
        }
        do {
            let rawFile = try await FrameService.fetchFile(
                workspaceId: workspaceId,
                file: reference,
                tokenProvider: tokenProvider
            )
            return FrameFilePayload(base64: rawFile.data.base64EncodedString(), contentType: rawFile.contentType)
        } catch {
            logger.error("Frame file fetch failed: \(error)")
            return .missing
        }
    }

    private func loadUserIdentity() async -> FrameUserIdentity {
        async let dustUser = currentUser()
        async let fileContext = context()
        guard let user = await dustUser else { return .anonymous }
        return await FrameUserIdentity(user: user, isFrameAuthor: fileContext.isFrameAuthor)
    }

    private func currentUser() async -> DustUser? {
        let task = user ?? Task { [tokenProvider] in
            do {
                return try await AuthService.fetchDustUser(tokenProvider: tokenProvider)
            } catch {
                logger.error("Frame user fetch failed: \(error)")
                return nil
            }
        }
        user = task
        return await task.value
    }

    private func context() async -> FrameFileContext {
        guard case let .id(frameFileId) = file else { return .empty }
        let task = fileContext ?? Task { [workspaceId, isFrameV2, tokenProvider] in
            await FrameService.fetchFileContext(
                workspaceId: workspaceId,
                frameFileId: frameFileId,
                isFrameV2: isFrameV2,
                tokenProvider: tokenProvider
            )
        }
        fileContext = task
        return await task.value
    }

    private func encode(_ value: some Encodable) throws -> String? {
        try String(bytes: encoder.encode(value), encoding: .utf8)
    }
}
