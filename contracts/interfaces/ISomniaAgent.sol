// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  Somnia IAgentRequester - consumer interface for invoking
///         decentralized AI / oracle / web-extraction agents on Somnia.
/// @notice This file is the canonical interface vendored from
///         github.com/somnia-chain/agentathon
///         (somnia-agents-skills/references/interfaces/IAgentRequester.sol).
///         An earlier in-house copy in this repo had the wrong enum names
///         (EXACT/NUMERIC/SUBJECTIVE → don't exist) and a fictional `Request`
///         struct shape, which meant every `createAdvancedRequest` we sent
///         was silently malformed at the consensus layer - workers picked
///         up the request, couldn't agree on a result shape, and let it
///         time out. This corrected file matches the on-chain platform
///         byte-for-byte.
///
///         Platform deployment:
///           - Mainnet (5031):  0x5E5205CF39E766118C01636bED000A54D93163E6
///           - Testnet (50312): 0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776

/// @notice How responses are aggregated to reach finality.
enum ConsensusType {
    Majority,   // Finalizes when `threshold` validators return byte-identical results
    Threshold   // Finalizes when `threshold` validators return any successful result
}

/// @notice Lifecycle status of a request or individual response.
enum ResponseStatus {
    None,       // 0 - uninitialized
    Pending,    // 1 - awaiting responses
    Success,    // 2 - consensus reached
    Failed,     // 3 - explicit failure
    TimedOut    // 4 - deadline elapsed before consensus
}

/// @notice A single validator's response to a request.
struct Response {
    address validator;
    bytes result;             // ABI-encoded return value(s) of the agent function
    ResponseStatus status;
    uint256 receipt;          // Off-chain receipt ID (currently always 0 on-chain)
    uint256 timestamp;
    uint256 executionCost;    // Self-reported, capped at perAgentBudget
}

/// @notice On-chain representation of an agent execution request.
struct Request {
    uint256 id;
    address requester;
    address callbackAddress;
    bytes4 callbackSelector;
    address[] subcommittee;
    Response[] responses;
    uint256 responseCount;
    uint256 failureCount;
    uint256 threshold;
    uint256 createdAt;
    uint256 deadline;
    ResponseStatus status;
    ConsensusType consensusType;
    uint256 remainingBudget;
    uint256 perAgentBudget;
}

/// @title IAgentRequester
/// @notice Consumer interface for invoking agents on Somnia. Methods on this
///         contract are the ENTRY POINTS - workers responding via
///         `submitResponse` are an internal-only flow.
interface IAgentRequester {
    error AgentNotFound(uint256 agentId);
    error RequestNotFound(uint256 requestId);
    error InsufficientDeposit(uint256 sent, uint256 required);

    event RequestCreated(
        uint256 indexed requestId,
        uint256 indexed agentId,
        uint256 perAgentBudget,
        bytes payload,
        address[] subcommittee
    );
    event RequestFinalized(uint256 indexed requestId, ResponseStatus status);

    /// @notice Standard request - default consensus (Majority), default sub
    ///         size (3), default timeout (15 min).
    function createRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload
    ) external payable returns (uint256 requestId);

    /// @notice Custom consensus parameters.
    function createAdvancedRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload,
        uint256 subcommitteeSize,
        uint256 threshold,
        ConsensusType consensusType,
        uint256 timeout
    ) external payable returns (uint256 requestId);

    /// @notice Operations-reserve floor. NOTE: meeting it only is NOT enough
    ///         to get the request executed - runners ignore requests whose
    ///         `perAgentBudget = (msg.value - reserve) / subSize` is zero.
    ///         Always fund `getRequestDeposit() + pricePerAgent × subSize`.
    function getRequestDeposit() external view returns (uint256);

    /// @notice Operations-reserve floor for a custom subcommittee size.
    function getAdvancedRequestDeposit(uint256 subcommitteeSize) external view returns (uint256);
}

/// @notice Callback signature your contract MUST implement to receive results.
///         The platform invokes this when consensus (or timeout) is reached.
interface IAgentRequesterHandler {
    function handleResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory details
    ) external;
}

/// @notice LLM Inference Agent (agentId = 12847293847561029384, same on
///         testnet + mainnet). Per-worker cost: 0.07 STT/SOMI. Default
///         consensus = Majority (deterministic - fixed seed, temp=0).
interface ILLMAgent {
    function inferString(
        string memory prompt,
        string memory system,
        bool chainOfThought,
        string[] memory allowedValues
    ) external returns (string memory response);

    function inferNumber(
        string memory prompt,
        string memory system,
        int256 minValue,
        int256 maxValue,
        bool chainOfThought
    ) external returns (int256 response);

    /// @notice An on-chain tool the LLM may call. The agent does NOT execute
    ///         it - when the model wants to call it, the agent YIELDS the
    ///         abi-encoded calldata back to the requester (finishReason
    ///         "tool_calls"), the requester executes it against any contract
    ///         and RESUMES the conversation by appending a (role:"tool")
    ///         message. Signature uses Solidity-style human form, e.g.
    ///         "placeBet(uint8 game, uint96 stakeWei)".
    struct OnchainTool { string signature; string description; }

    /// @notice Multi-turn chat where the LLM can call MCP tools (auto-executed
    ///         by the agent) and/or on-chain tools (yielded back as calldata).
    ///         This is the agent-native path: the model itself decides which
    ///         contract call to make. Each round-trip is a fresh createRequest
    ///         + consensus cycle. finishReason is "stop" | "tool_calls" |
    ///         "max_iterations".
    function inferToolsChat(
        string[] memory roles,
        string[] memory messages,
        string[] memory mcpServerUrls,
        OnchainTool[] memory onchainTools,
        uint256 maxIterations,
        bool chainOfThought
    ) external returns (
        string memory finishReason,
        string memory response,
        string[] memory updatedRoles,
        string[] memory updatedMessages,
        string[] memory pendingToolCallIds,
        bytes[] memory pendingToolCalls
    );
}

/// @notice JSON API Request Agent (agentId = 13174292974160097713). Fetches
///         JSON from public HTTPS endpoints and extracts a value by JSONPath
///         selector. Per-worker cost: 0.03 STT/SOMI. Consensus = Majority.
interface IJsonApiAgent {
    function fetchString(string memory url, string memory selector)
        external returns (string memory result);

    function fetchUint(string memory url, string memory selector, uint8 decimals)
        external returns (uint256 result);

    function fetchInt(string memory url, string memory selector, uint8 decimals)
        external returns (int256 result);
}

/// @notice LLM Parse Website Agent (agentId = 12875401142070969085). Reads a
///         web page (or searches a domain) and uses an on-chain LLM to extract
///         a structured field by NATURAL-LANGUAGE prompt - NOT a CSS selector.
///         Per-worker cost: 0.10 STT. Consensus = Majority. Signatures
///         vendored verbatim from
///         docs.somnia.network/agents/base-agents/llm-parse-website.
///         NOTE: the earlier in-repo `parseText(string,string,uint8)` was
///         fabricated and does NOT exist on the agent, so every request failed
///         consensus (workers cannot decode an unknown function selector).
///         ExtractString / ExtractANumber are the real entry points.
interface IParseWebsiteAgent {
    /// @param key                 field name to extract (e.g. "headline")
    /// @param description         field description to guide the LLM
    /// @param options             allowed values; pass an empty array for freeform
    /// @param prompt              natural-language extraction prompt / search term
    /// @param url                 page URL (base or direct)
    /// @param resolveUrl          true = search the domain; false = scrape this URL (1 page)
    /// @param numPages            max pages to fetch (capped at 1 when resolveUrl is false)
    /// @param confidenceThreshold min extraction confidence 0-100 to return a result
    function ExtractString(
        string memory key,
        string memory description,
        string[] memory options,
        string memory prompt,
        string memory url,
        bool resolveUrl,
        uint8 numPages,
        uint8 confidenceThreshold
    ) external returns (string memory result);

    function ExtractANumber(
        string memory key,
        string memory description,
        uint256 min,
        uint256 max,
        string memory prompt,
        string memory url,
        bool resolveUrl,
        uint8 numPages,
        uint8 confidenceThreshold
    ) external returns (uint256 result);
}

/// @dev Back-compat aliases - older files in this repo reference these names.
///      New code should use IAgentRequester / IAgentRequesterHandler.
interface ISomniaAgentPlatform is IAgentRequester {}
