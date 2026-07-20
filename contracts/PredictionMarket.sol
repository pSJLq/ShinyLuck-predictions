// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Owned, ReentrancyGuard} from "./common/Auth.sol";

/// @title  ShinyLuck Predictions - parimutuel prediction markets on X events.
/// @notice Bets are pooled per outcome in native STT. Winners split the losing
///         pools pro-rata; fees are carved from the LOSING side only, so a
///         winning bettor can never receive less than their stake back.
///         Resolution comes exclusively from the wired resolver contract
///         (XOracleResolver - Somnia on-chain agent consensus). If a market
///         cannot be resolved by its deadline, ANYONE can void it and every
///         bettor reclaims their full stake.
///
///         The house takes no directional risk: unlike the casino games there
///         is no bankroll exposure - payouts always come from the market's own
///         pools.
contract PredictionMarket is Owned, ReentrancyGuard {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    uint8 public constant MAX_OUTCOMES = 8;

    enum State { Open, Resolved, Voided }

    /// @dev Template drives which agent votes the resolver fires.
    ///      TWEET_METRIC   - metric of a specific tweet (likes/RT) vs buckets
    ///      FOLLOWERS_GTE  - follower count of a profile vs buckets
    ///      POSTS_COUNT_DAY- number of posts on a UTC date vs buckets
    ///      FREEFORM_LLM   - any question with explicit criteria, 3x LLM votes
    ///      RACE_ARGMAX    - K contenders compete on one metric; the winner is
    ///                       the unique argmax of the measured values (subject
    ///                       to raceThreshold), else the mandatory last
    ///                       fallback outcome ("nobody / tie")
    enum Template { TWEET_METRIC, FOLLOWERS_GTE, POSTS_COUNT_DAY, FREEFORM_LLM, RACE_ARGMAX }

    /// @dev Resolution source spec, fixed forever at creation - this is the
    ///      market's canonical "how it resolves" contract with the bettors.
    ///      For numeric templates `bucketBounds` maps a measured value onto an
    ///      outcome index: value <= bounds[i] => outcome i (first match),
    ///      otherwise the last outcome. len(bounds) == nOutcomes-1, ascending.
    ///      RACE_ARGMAX resolution semantics (mirrored by the resolver and the
    ///      x-oracle, all three must agree): measure one value per contender;
    ///      if the maximum is unique AND >= raceThreshold the winner is that
    ///      contender's outcome, otherwise the winner is the last outcome
    ///      (mandatory fallback label - "nobody" / "tie"). Contender i's
    ///      independent measurement source is raceUrls[i]: a JSON url read with
    ///      raceSelectors[i], or (when the selector is empty) a public page the
    ///      Parse agent reads using `criteria` + the outcome label as prompt.
    struct Spec {
        string primaryUrl;       // vote 0: JSON API agent url (x-oracle / syndication)
        string primarySelector;  // vote 0: JSONPath selector
        string secondaryUrl;     // vote 1: second independent source (json url / x.com page)
        string secondarySelector;// vote 1: JSONPath selector (JSON votes only)
        string criteria;         // human-readable resolution criteria; doubles as
                                 // the Parse/LLM extraction prompt
        uint256[] bucketBounds;
        string[] raceUrls;       // RACE: per-contender independent source url
        string[] raceSelectors;  // RACE: per-contender JSONPath ("" => Parse agent)
        uint256 raceThreshold;   // RACE: min winning value; below => fallback outcome
    }

    struct Market {
        address creator;
        uint64 closeTs;          // betting closes
        uint64 resolveDeadline;  // after this an unresolved market is voidable
        uint8 nOutcomes;
        uint8 winner;
        State state;
        Template template;
        uint16 platformFeeBps;   // snapshot at creation
        uint16 creatorFeeBps;    // snapshot at creation
        uint256 creatorBond;
        uint256 total;           // sum of all pools
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    uint256 public marketCount;
    mapping(uint256 => Market) internal _markets;
    mapping(uint256 => string) public questions;
    mapping(uint256 => string[]) internal _outcomes;
    mapping(uint256 => uint256[MAX_OUTCOMES]) internal _pools;
    mapping(uint256 => Spec) internal _specs;

    /// marketId => bettor => per-outcome stake
    mapping(uint256 => mapping(address => uint256[MAX_OUTCOMES])) internal _stakes;
    mapping(uint256 => mapping(address => bool)) public claimed;

    /// Pull-payment ledger for creator fees + returned bonds (casino pattern:
    /// credit here, recipient calls claimFunds()).
    mapping(address => uint256) public pendingFunds;

    address public resolver;
    bool public curatedMode = true;               // launch stance: curated
    mapping(address => bool) public allowedCreators;

    uint16 public platformFeeBps = 250;           // 2.5% of the losing pool
    uint16 public creatorFeeBps = 100;            // 1.0% of the losing pool
    uint256 public creationFee = 0.2 ether;       // routed to the resolver (agent deposits)
    uint256 public creatorBondAmount = 0.3 ether; // returned on resolve OR void
    uint256 public minBet = 0.01 ether;
    uint64 public minLeadTime = 10 minutes;       // closeTs must be at least this far out
    uint64 public minResolveBuffer = 30 minutes;  // resolveDeadline >= closeTs + buffer
    uint64 public maxResolveWindow = 30 days;

    uint256 public platformAccrued;               // owner-withdrawable fees

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event MarketCreated(
        uint256 indexed marketId,
        address indexed creator,
        Template template,
        string question,
        uint64 closeTs,
        uint64 resolveDeadline
    );
    event BetPlaced(uint256 indexed marketId, address indexed player, uint8 outcome, uint256 amount);
    event MarketResolved(uint256 indexed marketId, uint8 winner, uint256 total, uint256 fees);
    event MarketVoided(uint256 indexed marketId, string reason);
    event Claimed(uint256 indexed marketId, address indexed player, uint256 amount);
    event FundsClaimed(address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error NotResolver();
    error BadMarket();
    error BadState();
    error BettingClosed();
    error BettingStillOpen();
    error NotYetExpired();
    error BadOutcome();
    error BadValue();
    error NothingToClaim();
    error NotAllowedCreator();
    error BadParams();

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice ONE-SHOT wiring. Resolution authority is fixed forever the
    ///         moment it is set: the owner can never swap in a puppet
    ///         resolver and dictate winners. The only owner override on a
    ///         live market is a void through the resolver (full refunds).
    function setResolver(address r) external onlyOwner {
        require(r != address(0), "zero");
        require(resolver == address(0), "resolver locked");
        resolver = r;
    }

    function setCuratedMode(bool on) external onlyOwner { curatedMode = on; }

    function setAllowedCreator(address who, bool ok) external onlyOwner {
        allowedCreators[who] = ok;
    }

    function setFees(uint16 platformBps, uint16 creatorBps) external onlyOwner {
        // Combined fee capped at 10% of the losing pool - keeps "winners never
        // lose" trivially true and the product honest.
        require(uint256(platformBps) + creatorBps <= 1000, "fees>10%");
        platformFeeBps = platformBps;
        creatorFeeBps = creatorBps;
    }

    function setEconomics(uint256 creationFee_, uint256 bond_, uint256 minBet_) external onlyOwner {
        creationFee = creationFee_;
        creatorBondAmount = bond_;
        minBet = minBet_;
    }

    function setTimings(uint64 lead, uint64 buffer_, uint64 maxWindow) external onlyOwner {
        require(lead >= 1 minutes && buffer_ >= 5 minutes && maxWindow >= buffer_, "timings");
        minLeadTime = lead;
        minResolveBuffer = buffer_;
        maxResolveWindow = maxWindow;
    }

    function withdrawPlatform(address payable to, uint256 amount) external onlyOwner {
        require(amount <= platformAccrued, "exceeds accrued");
        platformAccrued -= amount;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "send failed");
    }

    // ------------------------------------------------------------------
    // Market lifecycle
    // ------------------------------------------------------------------

    function createMarket(
        Template template,
        string calldata question,
        string[] calldata outcomeLabels,
        uint64 closeTs,
        uint64 resolveDeadline,
        Spec calldata spec
    ) external payable returns (uint256 marketId) {
        if (curatedMode && msg.sender != owner && !allowedCreators[msg.sender]) {
            revert NotAllowedCreator();
        }
        uint256 n = outcomeLabels.length;
        if (n < 2 || n > MAX_OUTCOMES) revert BadParams();
        if (bytes(question).length == 0 || bytes(question).length > 400) revert BadParams();
        if (closeTs < block.timestamp + minLeadTime) revert BadParams();
        if (resolveDeadline < closeTs + minResolveBuffer) revert BadParams();
        if (resolveDeadline > closeTs + maxResolveWindow) revert BadParams();
        if (msg.value != creationFee + creatorBondAmount) revert BadValue();

        // Numeric templates need bucket bounds mapping a measured value onto
        // an outcome; the freeform LLM template must NOT have them (the LLM
        // answers with an outcome label directly); races need one independent
        // source per contender instead.
        if (template == Template.FREEFORM_LLM) {
            if (spec.bucketBounds.length != 0 || spec.raceUrls.length != 0) revert BadParams();
            if (bytes(spec.criteria).length == 0) revert BadParams();
        } else if (template == Template.RACE_ARGMAX) {
            // K contenders + a mandatory trailing fallback outcome ("nobody" /
            // "tie") so a below-threshold or tied race resolves to the
            // fallback instead of voiding.
            uint256 k = spec.raceUrls.length;
            if (k < 2 || n != k + 1) revert BadParams();
            if (spec.raceSelectors.length != k) revert BadParams();
            if (spec.bucketBounds.length != 0) revert BadParams();
            if (bytes(spec.primaryUrl).length == 0) revert BadParams();
            if (bytes(spec.criteria).length == 0) revert BadParams();
        } else {
            if (spec.bucketBounds.length != n - 1 || spec.raceUrls.length != 0) revert BadParams();
            for (uint256 i = 1; i < spec.bucketBounds.length; i++) {
                if (spec.bucketBounds[i] <= spec.bucketBounds[i - 1]) revert BadParams();
            }
            if (bytes(spec.primaryUrl).length == 0) revert BadParams();
        }

        marketId = marketCount++;
        Market storage m = _markets[marketId];
        m.creator = msg.sender;
        m.closeTs = closeTs;
        m.resolveDeadline = resolveDeadline;
        m.nOutcomes = uint8(n);
        m.state = State.Open;
        m.template = template;
        m.platformFeeBps = platformFeeBps;
        m.creatorFeeBps = creatorFeeBps;
        m.creatorBond = creatorBondAmount;

        questions[marketId] = question;
        _outcomes[marketId] = outcomeLabels;
        _specs[marketId] = spec;

        // Creation fee funds the resolver's agent deposits. If the resolver
        // can't take it (unset / reverting receive), accrue to the platform
        // instead of bricking market creation.
        if (creationFee > 0) {
            bool routed = false;
            if (resolver != address(0)) {
                (routed, ) = resolver.call{value: creationFee}("");
            }
            if (!routed) platformAccrued += creationFee;
        }

        emit MarketCreated(marketId, msg.sender, template, question, closeTs, resolveDeadline);
    }

    function bet(uint256 marketId, uint8 outcome) external payable {
        Market storage m = _requireMarket(marketId);
        if (m.state != State.Open) revert BadState();
        if (block.timestamp >= m.closeTs) revert BettingClosed();
        if (outcome >= m.nOutcomes) revert BadOutcome();
        if (msg.value < minBet) revert BadValue();

        _pools[marketId][outcome] += msg.value;
        m.total += msg.value;
        _stakes[marketId][msg.sender][outcome] += msg.value;

        emit BetPlaced(marketId, msg.sender, outcome, msg.value);
    }

    /// @notice Called by the resolver once agent consensus lands. If nobody
    ///         backed the winning outcome there is no counterparty to pay -
    ///         the market voids and everyone reclaims their stake.
    function resolve(uint256 marketId, uint8 winner) external onlyResolver {
        Market storage m = _requireMarket(marketId);
        if (m.state != State.Open) revert BadState();
        if (block.timestamp < m.closeTs) revert BettingStillOpen();
        if (winner >= m.nOutcomes) revert BadOutcome();

        if (_pools[marketId][winner] == 0) {
            _void(marketId, m, "no winning bets");
            return;
        }

        uint256 losing = m.total - _pools[marketId][winner];
        uint256 pf = (losing * m.platformFeeBps) / 10000;
        uint256 cf = (losing * m.creatorFeeBps) / 10000;
        platformAccrued += pf;
        pendingFunds[m.creator] += cf + m.creatorBond;

        m.winner = winner;
        m.state = State.Resolved;

        emit MarketResolved(marketId, winner, m.total, pf + cf);
    }

    /// @notice Resolver gave up (terminal disagreement between agent votes).
    function void(uint256 marketId, string calldata reason) external onlyResolver {
        Market storage m = _requireMarket(marketId);
        if (m.state != State.Open) revert BadState();
        _void(marketId, m, reason);
    }

    /// @notice Permissionless safety valve: unresolved past the deadline =>
    ///         full refunds. Nobody's money can get stuck on a broken oracle.
    function voidExpired(uint256 marketId) external {
        Market storage m = _requireMarket(marketId);
        if (m.state != State.Open) revert BadState();
        if (block.timestamp <= m.resolveDeadline) revert NotYetExpired();
        _void(marketId, m, "resolve deadline passed");
    }

    function _void(uint256 marketId, Market storage m, string memory reason) internal {
        m.state = State.Voided;
        pendingFunds[m.creator] += m.creatorBond;
        emit MarketVoided(marketId, reason);
    }

    // ------------------------------------------------------------------
    // Payouts
    // ------------------------------------------------------------------

    /// @notice Winner payout = stake_on_winner * (total - fees) / winning_pool.
    ///         Voided market => full refund of every stake. Pull-payment.
    function claim(uint256 marketId) external nonReentrant {
        Market storage m = _requireMarket(marketId);
        if (m.state == State.Open) revert BadState();
        if (claimed[marketId][msg.sender]) revert NothingToClaim();

        uint256 payout = _payoutOf(marketId, m, msg.sender);
        if (payout == 0) revert NothingToClaim();

        claimed[marketId][msg.sender] = true;
        (bool ok, ) = msg.sender.call{value: payout}("");
        require(ok, "send failed");

        emit Claimed(marketId, msg.sender, payout);
    }

    function claimFunds() external nonReentrant {
        uint256 amt = pendingFunds[msg.sender];
        if (amt == 0) revert NothingToClaim();
        pendingFunds[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amt}("");
        require(ok, "send failed");
        emit FundsClaimed(msg.sender, amt);
    }

    function _payoutOf(uint256 marketId, Market storage m, address who)
        internal
        view
        returns (uint256)
    {
        uint256[MAX_OUTCOMES] storage st = _stakes[marketId][who];
        if (m.state == State.Voided) {
            uint256 sum;
            for (uint8 i = 0; i < m.nOutcomes; i++) sum += st[i];
            return sum;
        }
        // Resolved
        uint256 stakeW = st[m.winner];
        if (stakeW == 0) return 0;
        uint256 losing = m.total - _pools[marketId][m.winner];
        uint256 fees = (losing * m.platformFeeBps) / 10000 + (losing * m.creatorFeeBps) / 10000;
        return (stakeW * (m.total - fees)) / _pools[marketId][m.winner];
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function _requireMarket(uint256 marketId) internal view returns (Market storage m) {
        if (marketId >= marketCount) revert BadMarket();
        m = _markets[marketId];
    }

    function getMarket(uint256 marketId)
        external
        view
        returns (Market memory m, string memory question, string[] memory outcomeLabels)
    {
        _requireMarket(marketId);
        return (_markets[marketId], questions[marketId], _outcomes[marketId]);
    }

    function getPools(uint256 marketId) external view returns (uint256[MAX_OUTCOMES] memory) {
        _requireMarket(marketId);
        return _pools[marketId];
    }

    function getSpec(uint256 marketId) external view returns (Spec memory) {
        _requireMarket(marketId);
        return _specs[marketId];
    }

    function stakesOf(uint256 marketId, address who)
        external
        view
        returns (uint256[MAX_OUTCOMES] memory)
    {
        _requireMarket(marketId);
        return _stakes[marketId][who];
    }

    function claimableOf(uint256 marketId, address who) external view returns (uint256) {
        Market storage m = _requireMarket(marketId);
        if (m.state == State.Open || claimed[marketId][who]) return 0;
        return _payoutOf(marketId, m, who);
    }

    /// @dev Everything the resolver needs to build agent votes, in one call.
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
        )
    {
        Market storage m = _requireMarket(marketId);
        return (
            uint8(m.state),
            uint8(m.template),
            m.closeTs,
            m.resolveDeadline,
            m.nOutcomes,
            m.total,
            _specs[marketId],
            _outcomes[marketId]
        );
    }
}
