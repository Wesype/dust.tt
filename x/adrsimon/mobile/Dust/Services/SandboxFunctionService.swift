import Foundation
import os

private let logger = Logger(subsystem: AppConfig.bundleId, category: "SandboxFunction")

private struct APIErrorResponse: Decodable {
    struct Body: Decodable {
        let type: String
        let message: String
    }

    let error: Body
}

enum SandboxFunctionService {
    private static let actionNotBlockedErrorType = "action_not_blocked"
    private static let invocationFailedErrorCode = "invocation_failed"

    static func invoke(
        workspaceId: String,
        functionIdOrSlug: String,
        input: JSONValue?,
        tokenProvider: TokenProvider
    ) async throws -> SandboxFunctionInvocationResponse {
        do {
            return try await APIClient.authenticatedPost(
                AppConfig.Endpoints.sandboxFunctionInvocations(
                    workspaceId: workspaceId,
                    functionIdOrSlug: functionIdOrSlug
                ),
                body: SandboxFunctionInvocationRequest(
                    input: input,
                    context: .init(timezone: TimeZone.current.identifier)
                ),
                tokenProvider: tokenProvider,
                snakeCase: false
            )
        } catch let APIError.httpError(statusCode, body) {
            let apiError = try? JSONDecoder().decode(APIErrorResponse.self, from: Data(body.utf8))
            throw SandboxFunctionCallError(
                code: apiError?.error.type ?? invocationFailedErrorCode,
                message: apiError?.error.message ?? body,
                status: statusCode
            )
        } catch {
            throw SandboxFunctionCallError.transport(error.localizedDescription)
        }
    }

    static func events(
        workspaceId: String,
        functionId: String,
        invocationId: String,
        lastEventId: String?,
        tokenProvider: TokenProvider
    ) -> AsyncThrowingStream<String, Error> {
        StreamingService.eventStream(
            endpoint: AppConfig.Endpoints.sandboxFunctionInvocationEvents(
                workspaceId: workspaceId,
                functionId: functionId,
                invocationId: invocationId
            ),
            tokenProvider: tokenProvider,
            lastEventId: lastEventId
        )
    }

    /// An action another client already resolved counts as validated.
    static func validateAction(
        workspaceId: String,
        approval: FrameFunctionApproval,
        approved: ActionApproval,
        tokenProvider: TokenProvider
    ) async throws {
        let endpoint = AppConfig.Endpoints.sandboxFunctionAction(
            workspaceId: workspaceId,
            functionId: approval.functionId,
            invocationId: approval.invocationId,
            actionId: approval.actionId
        )
        do {
            try await APIClient.authenticatedSend(
                "\(endpoint)/validate-action",
                method: "POST",
                body: SandboxFunctionValidateActionRequest(approved: approved.rawValue),
                tokenProvider: tokenProvider
            )
        } catch let APIError.httpError(_, body) where isActionNotBlocked(body) {
            logger.info("Frame function action \(approval.actionId) was already resolved")
        }
    }

    static func denyAuthentication(
        workspaceId: String,
        event: SandboxFunctionPersonalAuthRequiredEvent,
        tokenProvider: TokenProvider
    ) async throws {
        let endpoint = AppConfig.Endpoints.sandboxFunctionAction(
            workspaceId: workspaceId,
            functionId: event.sandboxFunctionId,
            invocationId: event.invocationId,
            actionId: event.actionId
        )
        do {
            try await APIClient.authenticatedSend(
                "\(endpoint)/resolve-authentication",
                method: "POST",
                body: SandboxFunctionAuthResolution(),
                tokenProvider: tokenProvider
            )
        } catch let APIError.httpError(_, body) where isActionNotBlocked(body) {
            logger.info("Frame function action \(event.actionId) was already resolved")
        }
    }

    private static func isActionNotBlocked(_ body: String) -> Bool {
        let apiError = try? JSONDecoder().decode(APIErrorResponse.self, from: Data(body.utf8))
        return apiError?.error.type == actionNotBlockedErrorType
    }
}
