// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Owned} from "./common/Auth.sol";
import {
    IAgentRequester,
    IAgentRequesterHandler,
    IJsonApiAgent,
    ILLMAgent,
    IParseWebsiteAgent,
    Response,
    Request,
    ResponseStatus
} from "./interfaces/ISomniaAgent.sol";

interface IPredictionMarketMin {
    struct Spec {
        string primaryUrl;
        string primarySelector;
        string secondaryUrl;
        string secondarySelector;
        string criteria;
        uint256[] bucketBounds;
        string[] raceUrls;
        string[] raceSelectors;
        uint256 raceThreshold;
    }

    function resolveData(uint256 marketId)
        external
        view
        returns (
            uint8 state,
            uint8 template,
            uint64 closeTs,
            uint64 resolveDeadline,
            uint8 nOutcomes,
            uint256 total,
            Spec memory spec,
            string[] memory outcomeLabels
        );

    function resolve(uint256 marketId, uint8 winner) external;

    function void(uint256 marketId, string calldata reason) external;
}

/// @title  XOracleResolver - resolves ShinyLuck prediction markets through
///         Somnia on-chain agent consensus (the same createRequest /
///         handleResponse machinery that runs ShinyLuck's HouseManager in
///         production).
/// @notice Decentralization model: fetching X data can never be trustless
///         (closed platform), so each market is resolved by SEVERAL
///         independent agent votes over DIFFERENT sources (our x-oracle
///         mirror, X's public syndication endpoints, an LLM parse of the
///         public page). Every vote is itself executed by a validator
///         subcommittee reaching consensus. The market only resolves when
///         M-of-N votes agree on the same outcome; otherwise a bounded retry,
///         and past the market's deadline anyone can void it for full refunds
///         (that path lives in PredictionMarket, not here).
contract XOracleResolver is Owned, IAgentRequesterHandler {
    // ------------------------------------------------------------------
    // Wiring - IMMUTABLE by design (trust model)
    //
    // The owner must never be able to forge an outcome. Everything that
    // decides WHO answers is fixed forever at deploy time: the agent
    // platform, the market, and the agent IDs. The owner keeps only knobs
    // that cannot fabricate a winner: pricing/timeouts (economics),
    // oracleBaseUrl (moves ONE of the votes' host - the other votes read
    // spec-pinned absolute URLs, so a hostile base can only fail rounds,
    // never forge consensus), and ownerVoidMarket (refunds, not outcomes).
    // ------------------------------------------------------------------

    IAgentRequester public immutable platform;
    IPredictionMarketMin public immutable market;

    // Agent IDs are identical on Somnia testnet and mainnet.
    uint256 public constant jsonAgentId = 13174292974160097713;
    uint256 public constant llmAgentId = 12847293847561029384;
    uint256 public constant parseAgentId = 12875401142070969085;

    // Per-worker prices (docs.somnia.network); the platform's default
    // subcommittee for createRequest is 3. Deposit formula per the vendored
    // interface: getRequestDeposit() + pricePerWorker * subSize - sending
    // only the reserve makes perAgentBudget=0 and runners skip the request.
    uint256 public jsonPricePerWorker = 0.03 ether;
    uint256 public llmPricePerWorker = 0.07 ether;
    uint256 public parsePricePerWorker = 0.10 ether;
    uint8 public subSize = 3;

    /// Base URL prepended to Spec.primaryUrl when it is a relative path
    /// (lets us migrate the x-oracle host - GitHub raw now, shinyluck.win
    /// later - without touching live markets).
    string public oracleBaseUrl;

    // ------------------------------------------------------------------
    // Rounds
    // ------------------------------------------------------------------

    // 1 oracle-winner vote + up to 7 race contenders (MAX_OUTCOMES-1).
    uint8 public constant MAX_VOTES = 8;
    uint8 public maxRounds = 4;          // griefing cap: agent deposits per market
    uint64 public roundTimeout = 25 minutes; // platform default request timeout is 15m

    /// NUM: numeric result bucketed through bucketBounds.
    /// STR: label result matched against outcome labels.
    /// IDX: numeric result IS the outcome index (x-oracle's precomputed winner).
    /// MEASURE: raw per-contender measurement for the on-chain race argmax.
    enum VoteKind { NONE, NUM, STR, IDX, MEASURE }

    struct Round {
        uint32 seq;          // increments every round; stale callbacks are dropped
        uint8 fired;         // votes fired this round
        uint8 received;      // callbacks landed (incl. failures)
        uint8 roundsUsed;    // lifetime rounds for this market
        uint64 startedAt;
        bool active;
        bool isRace;         // consensus dispatch: argmax vs M-of-N
        // vote results this round: 0..7 outcome, ABSTAIN for failed/timeout,
        // MEASURED for landed race measurements (value lives in `raw`)
        uint8[MAX_VOTES] votes;
        uint256[MAX_VOTES] raw; // race: measured value per vote slot
    }

    uint8 internal constant ABSTAIN = type(uint8).max;
    uint8 internal constant PENDING = type(uint8).max - 1;
    uint8 internal constant MEASURED = type(uint8).max - 2;

    mapping(uint256 => Round) public rounds; // marketId => round state

    struct VoteRef {
        uint256 marketId;
        uint32 seq;
        uint8 voteIdx;
        VoteKind kind;
        bool used; // guards double-callback for the same requestId
    }

    mapping(uint256 => VoteRef) public pendingVotes; // requestId => ref

    /// Latest round's per-slot request metadata, kept in state so ANY frontend
    /// can show full provenance (agent + receipt id + subcommittee stats per
    /// vote) with plain view calls - Somnia's public RPC caps eth_getLogs at
    /// 1000 blocks, so log scans are not a viable path for the UI.
    struct VoteMeta {
        uint256 requestId;
        uint256 agentId;
        uint32 responded;  // validators that responded (from the platform callback)
        uint32 agreed;     // responses in the winning consensus set
    }

    mapping(uint256 => VoteMeta[MAX_VOTES]) internal _voteMeta; // marketId => slot => meta

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event ResolveRoundStarted(uint256 indexed marketId, uint32 seq, uint8 votesFired);
    event VoteRequestFired(
        uint256 indexed marketId,
        uint32 seq,
        uint8 voteIdx,
        uint256 requestId,
        uint256 agentId
    );
    event VoteLanded(
        uint256 indexed marketId,
        uint32 seq,
        uint8 voteIdx,
        uint8 outcome, // ABSTAIN = failed/timeout/unresolved
        uint256 requestId
    );
    event ConsensusReached(uint256 indexed marketId, uint32 seq, uint8 winner);
    event RoundFailed(uint256 indexed marketId, uint32 seq, string reason);
    event MarketVoidRequested(uint256 indexed marketId, string reason);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error NotPlatform();
    error MarketNotResolvable();
    error RoundInFlight();
    error RoundsExhausted();
    error InsufficientFunding();
    error NoBets();

    constructor(address platform_, address market_) {
        platform = IAgentRequester(platform_);
        market = IPredictionMarketMin(market_);
    }

    /// Agent deposits are paid from this contract's balance; PredictionMarket
    /// routes creation fees here and the owner can top up directly.
    receive() external payable {}

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setPricing(uint256 json, uint256 llm, uint256 parse, uint8 subSize_) external onlyOwner {
        require(subSize_ > 0 && subSize_ <= 9, "subSize");
        jsonPricePerWorker = json;
        llmPricePerWorker = llm;
        parsePricePerWorker = parse;
        subSize = subSize_;
    }

    function setOracleBaseUrl(string calldata base) external onlyOwner {
        oracleBaseUrl = base;
    }

    function setRoundParams(uint8 maxRounds_, uint64 timeout_) external onlyOwner {
        require(maxRounds_ > 0 && timeout_ >= 5 minutes, "params");
        maxRounds = maxRounds_;
        roundTimeout = timeout_;
    }

    function ownerWithdraw(address payable to, uint256 amount) external onlyOwner {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "send failed");
    }

    /// Terminal give-up before the deadline (e.g. malformed market spec that
    /// keeps failing): owner can push the market into refunds early instead of
    /// letting bettors wait for voidExpired.
    function ownerVoidMarket(uint256 marketId, string calldata reason) external onlyOwner {
        market.void(marketId, reason);
        emit MarketVoidRequested(marketId, reason);
    }

    // ------------------------------------------------------------------
    // Cost quoting (HouseManager pattern: reserve + price * subSize)
    // ------------------------------------------------------------------

    function quoteJsonCost() public view returns (uint256) {
        return platform.getRequestDeposit() + jsonPricePerWorker * subSize;
    }

    function quoteLlmCost() public view returns (uint256) {
        return platform.getRequestDeposit() + llmPricePerWorker * subSize;
    }

    function quoteParseCost() public view returns (uint256) {
        return platform.getRequestDeposit() + parsePricePerWorker * subSize;
    }

    /// Total cost of one resolve round for the given market.
    function quoteRoundCost(uint256 marketId) public view returns (uint256) {
        (, uint8 template, , , , , IPredictionMarketMin.Spec memory spec, ) = _data(marketId);
        if (template == 3) return quoteLlmCost() * 3;            // FREEFORM_LLM
        if (template == 0) return quoteJsonCost() * 2;           // TWEET_METRIC
        if (template == 4) return _raceCost(spec);               // RACE_ARGMAX
        // FOLLOWERS / POSTS: single-source when no secondary reader exists
        if (bytes(spec.secondaryUrl).length == 0) return quoteJsonCost();
        return quoteJsonCost() + quoteParseCost();
    }

    /// RACE: 1 JSON winner-index vote + per contender either a JSON read
    /// (selector given) or a Parse extraction (empty selector).
    function _raceCost(IPredictionMarketMin.Spec memory spec) internal view returns (uint256) {
        uint256 cj = quoteJsonCost();
        uint256 cost = cj;
        for (uint256 i = 0; i < spec.raceUrls.length; i++) {
            cost += bytes(spec.raceSelectors[i]).length > 0 ? cj : quoteParseCost();
        }
        return cost;
    }

    // ------------------------------------------------------------------
    // Resolution rounds
    // ------------------------------------------------------------------

    /// @notice Permissionless kick (the keeper calls it, but anyone can).
    ///         Fires this market's agent votes. Re-callable when the previous
    ///         round either completed without consensus or timed out.
    function startResolve(uint256 marketId) external {
        (
            uint8 state,
            uint8 template,
            uint64 closeTs,
            ,
            ,
            uint256 total,
            IPredictionMarketMin.Spec memory spec,
            string[] memory labels
        ) = _data(marketId);

        if (state != 0 || block.timestamp < closeTs) revert MarketNotResolvable();
        if (total == 0) revert NoBets(); // nothing at stake - let it void at deadline

        Round storage r = rounds[marketId];
        if (r.active && block.timestamp < r.startedAt + roundTimeout) revert RoundInFlight();
        if (r.roundsUsed >= maxRounds) revert RoundsExhausted();

        r.seq += 1;
        r.roundsUsed += 1;
        r.active = true;
        r.startedAt = uint64(block.timestamp);
        r.fired = 0;
        r.received = 0;
        r.isRace = false;
        for (uint8 i = 0; i < MAX_VOTES; i++) r.votes[i] = PENDING;

        if (template == 3) {
            // FREEFORM_LLM: 3 independent LLM votes, 2-of-3.
            uint256 cost = quoteLlmCost();
            if (address(this).balance < cost * 3) revert InsufficientFunding();
            for (uint8 i = 0; i < 3; i++) {
                _fireLlmVote(marketId, r.seq, i, cost, spec.criteria, labels);
            }
            r.fired = 3;
        } else if (template == 0) {
            // TWEET_METRIC: two JSON votes over two independent urls, 2-of-2.
            uint256 cost = quoteJsonCost();
            if (address(this).balance < cost * 2) revert InsufficientFunding();
            _fireJsonVote(marketId, r.seq, 0, cost, _resolveUrl(spec.primaryUrl), spec.primarySelector, VoteKind.NUM);
            _fireJsonVote(marketId, r.seq, 1, cost, spec.secondaryUrl, spec.secondarySelector, VoteKind.NUM);
            r.fired = 2;
        } else if (template == 4) {
            // RACE_ARGMAX: vote 0 = the x-oracle's precomputed winner index;
            // votes 1..K = one independent measurement per contender. The
            // round only resolves when the on-chain argmax of the
            // measurements agrees with the oracle's answer.
            uint256 cj = quoteJsonCost();
            uint256 cp = quoteParseCost();
            if (address(this).balance < _raceCost(spec)) revert InsufficientFunding();
            _fireJsonVote(marketId, r.seq, 0, cj, _resolveUrl(spec.primaryUrl), spec.primarySelector, VoteKind.IDX);
            uint8 k = uint8(spec.raceUrls.length);
            for (uint8 i = 0; i < k; i++) {
                if (bytes(spec.raceSelectors[i]).length > 0) {
                    _fireJsonVote(marketId, r.seq, i + 1, cj, spec.raceUrls[i], spec.raceSelectors[i], VoteKind.MEASURE);
                } else {
                    _fireParseVote(
                        marketId, r.seq, i + 1, cp,
                        string(abi.encodePacked(spec.criteria, " -- measure this metric for: ", labels[i])),
                        spec.raceUrls[i],
                        VoteKind.MEASURE
                    );
                }
            }
            r.fired = k + 1;
            r.isRace = true;
        } else {
            // FOLLOWERS_GTE / POSTS_COUNT_DAY. Profile data sits behind X's
            // login wall, so a second independent reader may not exist: with a
            // secondary source the market cross-checks 2-of-2 (JSON + Parse);
            // with none it openly resolves from the x-oracle's published
            // measurement alone (1-of-1). The UI labels these single-source;
            // the published JSON and the measurement method stay publicly
            // re-verifiable, and the deadline-void refund path still applies.
            uint256 cj = quoteJsonCost();
            if (bytes(spec.secondaryUrl).length == 0) {
                if (address(this).balance < cj) revert InsufficientFunding();
                _fireJsonVote(marketId, r.seq, 0, cj, _resolveUrl(spec.primaryUrl), spec.primarySelector, VoteKind.NUM);
                r.fired = 1;
            } else {
                uint256 cp = quoteParseCost();
                if (address(this).balance < cj + cp) revert InsufficientFunding();
                _fireJsonVote(marketId, r.seq, 0, cj, _resolveUrl(spec.primaryUrl), spec.primarySelector, VoteKind.NUM);
                _fireParseVote(marketId, r.seq, 1, cp, spec.criteria, spec.secondaryUrl, VoteKind.NUM);
                r.fired = 2;
            }
        }

        emit ResolveRoundStarted(marketId, r.seq, r.fired);
    }

    function _fireJsonVote(
        uint256 marketId,
        uint32 seq,
        uint8 voteIdx,
        uint256 cost,
        string memory url,
        string memory selector,
        VoteKind kind
    ) internal {
        bytes memory payload = abi.encodeWithSelector(
            IJsonApiAgent.fetchUint.selector,
            url,
            selector,
            uint8(0) // raw integer, no decimal scaling
        );
        uint256 requestId = platform.createRequest{value: cost}(
            jsonAgentId,
            address(this),
            this.handleResponse.selector,
            payload
        );
        pendingVotes[requestId] =
            VoteRef({marketId: marketId, seq: seq, voteIdx: voteIdx, kind: kind, used: false});
        _voteMeta[marketId][voteIdx] = VoteMeta(requestId, jsonAgentId, 0, 0);
        emit VoteRequestFired(marketId, seq, voteIdx, requestId, jsonAgentId);
    }

    function _fireParseVote(
        uint256 marketId,
        uint32 seq,
        uint8 voteIdx,
        uint256 cost,
        string memory prompt,
        string memory url,
        VoteKind kind
    ) internal {
        bytes memory payload = abi.encodeWithSelector(
            IParseWebsiteAgent.ExtractANumber.selector,
            "metric",
            "The exact numeric value described by the extraction prompt",
            uint256(0),
            // sane bound: type(uint256).max crashes the agent runtime with a
            // 500 before it even scrapes (proven live, receipts 7130809 vs
            // 7131520). 1e15 covers any X metric with huge headroom.
            uint256(1e15),
            prompt,             // natural-language extraction prompt
            url,                // public page to scrape
            false,              // scrape this exact URL
            uint8(1),
            uint8(50)           // confidence threshold
        );
        uint256 requestId = platform.createRequest{value: cost}(
            parseAgentId,
            address(this),
            this.handleResponse.selector,
            payload
        );
        pendingVotes[requestId] =
            VoteRef({marketId: marketId, seq: seq, voteIdx: voteIdx, kind: kind, used: false});
        _voteMeta[marketId][voteIdx] = VoteMeta(requestId, parseAgentId, 0, 0);
        emit VoteRequestFired(marketId, seq, voteIdx, requestId, parseAgentId);
    }

    function _fireLlmVote(
        uint256 marketId,
        uint32 seq,
        uint8 voteIdx,
        uint256 cost,
        string memory criteria,
        string[] memory labels
    ) internal {
        // allowedValues = outcome labels + UNRESOLVED escape hatch.
        string[] memory allowed = new string[](labels.length + 1);
        for (uint256 i = 0; i < labels.length; i++) allowed[i] = labels[i];
        allowed[labels.length] = "UNRESOLVED";

        string memory system =
            "You resolve a prediction market. Apply the resolution criteria "
            "literally and reply with EXACTLY one of the allowed values. If the "
            "criteria cannot be verified with high confidence, reply UNRESOLVED.";

        bytes memory payload = abi.encodeWithSelector(
            ILLMAgent.inferString.selector,
            criteria,
            system,
            false,
            allowed
        );
        uint256 requestId = platform.createRequest{value: cost}(
            llmAgentId,
            address(this),
            this.handleResponse.selector,
            payload
        );
        pendingVotes[requestId] =
            VoteRef({marketId: marketId, seq: seq, voteIdx: voteIdx, kind: VoteKind.STR, used: false});
        _voteMeta[marketId][voteIdx] = VoteMeta(requestId, llmAgentId, 0, 0);
        emit VoteRequestFired(marketId, seq, voteIdx, requestId, llmAgentId);
    }

    // ------------------------------------------------------------------
    // Agent callback
    // ------------------------------------------------------------------

    function handleResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory details
    ) external override {
        if (msg.sender != address(platform)) revert NotPlatform();

        VoteRef storage ref = pendingVotes[requestId];
        // Unknown (kind never set) or already-consumed requestId: ignore
        // (platform retries, duplicate finalizations, stray callbacks).
        if (ref.used || ref.kind == VoteKind.NONE) return;
        ref.used = true;

        // Subcommittee stats for the provenance UI ("3/3 responded, 3/3
        // agreed") - scoped to the stored request so stale rounds never
        // overwrite the displayed round's numbers.
        VoteMeta storage vm = _voteMeta[ref.marketId][ref.voteIdx];
        if (vm.requestId == requestId) {
            vm.responded = uint32(details.responseCount);
            vm.agreed = uint32(responses.length);
        }

        Round storage r = rounds[ref.marketId];
        // Stale round (a newer round superseded this one): drop silently.
        if (!r.active || ref.seq != r.seq) return;

        if (r.votes[ref.voteIdx] != PENDING) return; // duplicate voteIdx guard

        uint8 outcome = ABSTAIN;
        if (status == ResponseStatus.Success && responses.length > 0) {
            if (ref.kind == VoteKind.MEASURE) {
                // Raw per-contender measurement: park the value, argmax later.
                try this.tryDecodeUint(responses[0].result) returns (uint256 v) {
                    r.raw[ref.voteIdx] = v;
                    outcome = MEASURED;
                } catch {}
            } else if (ref.kind == VoteKind.IDX) {
                // The value IS the outcome index (x-oracle's computed winner).
                try this.tryDecodeUint(responses[0].result) returns (uint256 v) {
                    (, , , , uint8 nOutcomes, , , ) = _data(ref.marketId);
                    if (v < nOutcomes) outcome = uint8(v);
                } catch {}
            } else {
                outcome = _normalize(ref.marketId, ref.kind, responses[0].result);
            }
        }

        r.votes[ref.voteIdx] = outcome;
        r.received += 1;
        emit VoteLanded(ref.marketId, ref.seq, ref.voteIdx, outcome, requestId);

        if (r.received < r.fired) return;

        // All votes landed - evaluate consensus.
        (uint8 winner, bool ok) =
            r.isRace ? _raceConsensus(ref.marketId, r) : _consensus(r);
        r.active = false;
        if (!ok) {
            emit RoundFailed(ref.marketId, ref.seq, "no consensus");
            return;
        }

        // try/catch: if the market was voided/resolved meanwhile the callback
        // must not revert (a reverting handler would burn the platform's
        // retry budget for nothing - reactivity example lesson).
        try market.resolve(ref.marketId, winner) {
            emit ConsensusReached(ref.marketId, ref.seq, winner);
        } catch {
            emit RoundFailed(ref.marketId, ref.seq, "market.resolve reverted");
        }
    }

    /// RACE consensus: the x-oracle's winner index (vote 0) must equal the
    /// argmax the chain computes ITSELF from the K independent measurements
    /// (votes 1..K). Semantics shared with the market spec and the oracle:
    /// unique max >= raceThreshold => that contender; tie at the top or
    /// nobody past the threshold => the mandatory fallback outcome (last
    /// label). Any failed measurement => no consensus, bounded retry.
    function _raceConsensus(uint256 marketId, Round storage r)
        internal
        view
        returns (uint8 winner, bool ok)
    {
        uint8 oracleVote = r.votes[0];
        if (oracleVote >= MEASURED) return (0, false); // abstained/garbage oracle vote

        (, , , , uint8 nOutcomes, , IPredictionMarketMin.Spec memory spec, ) = _data(marketId);

        uint8 k = r.fired - 1;
        uint256 best;
        uint8 bestIdx;
        bool tie;
        for (uint8 i = 0; i < k; i++) {
            if (r.votes[i + 1] != MEASURED) return (0, false); // measurement failed
            uint256 v = r.raw[i + 1];
            if (i == 0 || v > best) {
                best = v;
                bestIdx = i;
                tie = false;
            } else if (v == best) {
                tie = true;
            }
        }

        uint8 independent =
            (!tie && best >= spec.raceThreshold) ? bestIdx : nOutcomes - 1;
        if (independent != oracleVote) return (0, false);
        return (independent, true);
    }

    /// M-of-N: 2 votes => both must agree; 3 votes => any 2 agree.
    function _consensus(Round storage r) internal view returns (uint8 winner, bool ok) {
        uint8 needed = r.fired == 3 ? 2 : r.fired; // 2-of-3 or N-of-N
        for (uint8 i = 0; i < r.fired; i++) {
            uint8 v = r.votes[i];
            if (v == ABSTAIN || v == PENDING) continue;
            uint8 count = 1;
            for (uint8 j = i + 1; j < r.fired; j++) {
                if (r.votes[j] == v) count++;
            }
            if (count >= needed) return (v, true);
        }
        return (0, false);
    }

    /// Numeric result -> bucket index via the market's bucketBounds
    /// (value <= bounds[i] => outcome i, else last outcome).
    /// String result -> exact outcome-label match; UNRESOLVED/garbage -> ABSTAIN.
    function _normalize(uint256 marketId, VoteKind kind, bytes memory result)
        internal
        view
        returns (uint8)
    {
        (, , , , uint8 nOutcomes, , IPredictionMarketMin.Spec memory spec, string[] memory labels) =
            _data(marketId);

        if (kind == VoteKind.NUM) {
            uint256 value;
            try this.tryDecodeUint(result) returns (uint256 v) {
                value = v;
            } catch {
                return ABSTAIN;
            }
            for (uint256 i = 0; i < spec.bucketBounds.length; i++) {
                if (value <= spec.bucketBounds[i]) return uint8(i);
            }
            return nOutcomes - 1;
        }

        // VoteKind.STR
        string memory s;
        try this.tryDecodeString(result) returns (string memory v) {
            s = v;
        } catch {
            return ABSTAIN;
        }
        bytes32 h = keccak256(bytes(s));
        for (uint256 i = 0; i < labels.length; i++) {
            if (h == keccak256(bytes(labels[i]))) return uint8(i);
        }
        return ABSTAIN;
    }

    // External-self-call decode trick (HouseManager pattern): abi.decode on
    // malformed bytes reverts; try/catch only works across external calls.
    function tryDecodeUint(bytes memory data) external pure returns (uint256) {
        return abi.decode(data, (uint256));
    }

    function tryDecodeString(bytes memory data) external pure returns (string memory) {
        return abi.decode(data, (string));
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _data(uint256 marketId)
        internal
        view
        returns (
            uint8 state,
            uint8 template,
            uint64 closeTs,
            uint64 resolveDeadline,
            uint8 nOutcomes,
            uint256 total,
            IPredictionMarketMin.Spec memory spec,
            string[] memory labels
        )
    {
        return market.resolveData(marketId);
    }

    /// Relative primaryUrl (e.g. "3.json") gets the migratable base prefix;
    /// absolute urls ("https://...") pass through untouched.
    function _resolveUrl(string memory u) internal view returns (string memory) {
        bytes memory b = bytes(u);
        if (b.length >= 8) {
            // starts with "https://" ?
            if (
                b[0] == "h" && b[1] == "t" && b[2] == "t" && b[3] == "p" &&
                b[4] == "s" && b[5] == ":" && b[6] == "/" && b[7] == "/"
            ) return u;
        }
        return string(abi.encodePacked(oracleBaseUrl, u));
    }

    /// A round whose callbacks never arrived can be closed manually after the
    /// timeout so RoundsExhausted accounting stays truthful (startResolve
    /// already allows re-entry after roundTimeout; this is just hygiene).
    function expireRound(uint256 marketId) external {
        Round storage r = rounds[marketId];
        require(r.active && block.timestamp >= r.startedAt + roundTimeout, "not expired");
        r.active = false;
        emit RoundFailed(marketId, r.seq, "round timeout");
    }

    /// Full provenance of the latest round in one view call: which agent
    /// answered each vote slot, under which platform receipt id, and how the
    /// validator subcommittee voted.
    function getVoteMeta(uint256 marketId)
        external
        view
        returns (
            uint256[MAX_VOTES] memory requestIds,
            uint256[MAX_VOTES] memory agentIds,
            uint32[MAX_VOTES] memory responded,
            uint32[MAX_VOTES] memory agreed
        )
    {
        for (uint8 i = 0; i < MAX_VOTES; i++) {
            VoteMeta storage vm = _voteMeta[marketId][i];
            requestIds[i] = vm.requestId;
            agentIds[i] = vm.agentId;
            responded[i] = vm.responded;
            agreed[i] = vm.agreed;
        }
    }

    function getRound(uint256 marketId)
        external
        view
        returns (
            uint32 seq,
            bool active,
            uint8 fired,
            uint8 received,
            uint8 roundsUsed,
            uint8[MAX_VOTES] memory votes,
            uint256[MAX_VOTES] memory raw
        )
    {
        Round storage r = rounds[marketId];
        return (r.seq, r.active, r.fired, r.received, r.roundsUsed, r.votes, r.raw);
    }
}
