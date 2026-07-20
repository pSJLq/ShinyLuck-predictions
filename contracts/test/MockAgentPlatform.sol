// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IAgentRequester,
    IAgentRequesterHandler,
    Response,
    Request,
    ResponseStatus,
    ConsensusType
} from "../interfaces/ISomniaAgent.sol";

/// @dev Test double for the Somnia Agents platform. Records createRequest
///      calls; tests trigger callbacks via respond()/respondRaw() with
///      arbitrary results and statuses, from the platform address itself -
///      exactly how the real platform finalizes.
contract MockAgentPlatform is IAgentRequester {
    uint256 public nextRequestId = 1;
    uint256 public depositFloor = 0.001 ether;

    struct Stored {
        uint256 agentId;
        address callbackAddress;
        bytes4 callbackSelector;
        bytes payload;
        uint256 value;
    }

    mapping(uint256 => Stored) public stored;
    uint256[] public allRequestIds;

    function createRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload
    ) external payable returns (uint256 requestId) {
        require(msg.value >= depositFloor, "deposit");
        requestId = nextRequestId++;
        stored[requestId] = Stored(agentId, callbackAddress, callbackSelector, payload, msg.value);
        allRequestIds.push(requestId);
        emit RequestCreated(requestId, agentId, msg.value, payload, new address[](0));
    }

    function createAdvancedRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload,
        uint256,
        uint256,
        ConsensusType,
        uint256
    ) external payable returns (uint256 requestId) {
        requestId = nextRequestId++;
        stored[requestId] = Stored(agentId, callbackAddress, callbackSelector, payload, msg.value);
        allRequestIds.push(requestId);
    }

    function getRequestDeposit() external view returns (uint256) {
        return depositFloor;
    }

    function getAdvancedRequestDeposit(uint256) external view returns (uint256) {
        return depositFloor;
    }

    function requestIdsCount() external view returns (uint256) {
        return allRequestIds.length;
    }

    function lastRequestId() external view returns (uint256) {
        return allRequestIds[allRequestIds.length - 1];
    }

    /// Finalize a request with a successful consensus result.
    function respond(uint256 requestId, bytes calldata result) external {
        _finalize(requestId, result, ResponseStatus.Success);
    }

    /// Finalize with an explicit status (Failed / TimedOut paths).
    function respondWithStatus(uint256 requestId, bytes calldata result, ResponseStatus status)
        external
    {
        _finalize(requestId, result, status);
    }

    function _finalize(uint256 requestId, bytes memory result, ResponseStatus status) internal {
        Stored memory s = stored[requestId];
        require(s.callbackAddress != address(0), "unknown request");

        Response[] memory responses;
        if (status == ResponseStatus.Success) {
            responses = new Response[](1);
            responses[0] = Response({
                validator: address(this),
                result: result,
                status: status,
                receipt: 0,
                timestamp: block.timestamp,
                executionCost: 0
            });
        } else {
            responses = new Response[](0);
        }

        Request memory req; // mostly zeroed details
        req.id = requestId;
        req.status = status;
        // simulate a 3-validator subcommittee for provenance-stat tests
        req.responseCount = status == ResponseStatus.Success ? 3 : 0;
        req.threshold = 2;

        IAgentRequesterHandler(s.callbackAddress).handleResponse(requestId, responses, status, req);
        emit RequestFinalized(requestId, status);
    }
}
