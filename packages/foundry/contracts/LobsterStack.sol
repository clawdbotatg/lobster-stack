// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title LobsterStack
 * @notice A pyramid/stack game where users pay $CLAWD to enter positions.
 * Earlier participants earn from later entrants.
 * Uses Masterchef accumulator pattern for O(1) gas earnings calculation.
 */
contract LobsterStack is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 private constant PRECISION = 1e18;

    // ============ Immutables ============
    IERC20 public immutable clawdToken;
    address public immutable treasury;

    // ============ Configuration ============
    uint256 public entryCost;
    uint256 public participantBps; // e.g., 6000 = 60%
    uint256 public burnBps;        // e.g., 2000 = 20%
    uint256 public instantRewardBps; // e.g., 1500 = 15% — sent back to entrant immediately
    // Remaining = rewardPool BPS: BPS_DENOMINATOR - participantBps - burnBps - instantRewardBps

    // ============ Stack State ============
    uint256 public totalLobsters;
    bool public paused;

    // Masterchef accumulator — scaled by PRECISION
    uint256 public accEarningsPerPosition;

    struct Lobster {
        address owner;
        uint256 enteredAt;
        uint256 position;       // 1-indexed
        uint256 earningsDebt;   // accEarningsPerPosition at time of entry (scaled)
        uint256 claimedAmount;  // already claimed for this position
    }

    mapping(uint256 => Lobster) public lobsters;          // position => Lobster
    mapping(address => uint256[]) public userPositions;   // user => array of position IDs

    // ============ Stats ============
    uint256 public totalBurned;
    uint256 public totalPaidOut;
    uint256 public rewardPool;

    // ============ Events ============
    event LobsterEntered(uint256 indexed position, address indexed owner, uint256 cost);
    event EarningsClaimed(address indexed user, uint256 amount);
    event EntryCostUpdated(uint256 oldCost, uint256 newCost);
    event DistributionUpdated(uint256 participantBps, uint256 burnBps, uint256 instantRewardBps);
    event PauseUpdated(bool paused);
    event RewardPoolWithdrawn(address indexed to, uint256 amount);

    // ============ Modifiers ============
    modifier whenNotPaused() {
        require(!paused, "LobsterStack: paused");
        _;
    }

    // ============ Constructor ============
    constructor(
        address _clawdToken,
        address _treasury,
        uint256 _entryCost,
        uint256 _participantBps,
        uint256 _burnBps,
        uint256 _instantRewardBps
    ) Ownable(msg.sender) {
        require(_clawdToken != address(0), "Invalid token");
        require(_treasury != address(0), "Invalid treasury");
        require(
            _participantBps + _burnBps + _instantRewardBps <= BPS_DENOMINATOR,
            "BPS exceeds 100%"
        );

        clawdToken = IERC20(_clawdToken);
        treasury = _treasury;
        entryCost = _entryCost;
        participantBps = _participantBps;
        burnBps = _burnBps;
        instantRewardBps = _instantRewardBps;
    }

    // ============ User Functions ============

    /**
     * @notice Enter the lobster stack. Pays entryCost CLAWD.
     * @dev User must have approved this contract for entryCost first.
     */
    function enterStack() external nonReentrant whenNotPaused {
        require(entryCost > 0, "Entry cost not set");

        // 1. Transfer CLAWD from user
        clawdToken.safeTransferFrom(msg.sender, address(this), entryCost);

        // 2. Calculate splits
        uint256 participantShare = (entryCost * participantBps) / BPS_DENOMINATOR;
        uint256 burnAmount = (entryCost * burnBps) / BPS_DENOMINATOR;
        uint256 instantReward = (entryCost * instantRewardBps) / BPS_DENOMINATOR;
        uint256 poolAmount = entryCost - participantShare - burnAmount - instantReward;

        // 3. Update accumulator for earlier participants (Masterchef pattern)
        if (totalLobsters > 0) {
            accEarningsPerPosition += (participantShare * PRECISION) / totalLobsters;
            totalPaidOut += participantShare;
        } else {
            // First entrant — participant share goes to reward pool
            poolAmount += participantShare;
        }

        // 4. Burn
        if (burnAmount > 0) {
            clawdToken.safeTransfer(DEAD, burnAmount);
            totalBurned += burnAmount;
        }

        // 5. Instant reward — sent back to the entrant immediately
        if (instantReward > 0) {
            clawdToken.safeTransfer(msg.sender, instantReward);
        }

        // 6. Reward pool
        rewardPool += poolAmount;

        // 7. Create new position
        totalLobsters++;
        lobsters[totalLobsters] = Lobster({
            owner: msg.sender,
            enteredAt: block.timestamp,
            position: totalLobsters,
            earningsDebt: accEarningsPerPosition,
            claimedAmount: 0
        });
        userPositions[msg.sender].push(totalLobsters);

        emit LobsterEntered(totalLobsters, msg.sender, entryCost);
    }

    /**
     * @notice Claim all unclaimed earnings across all positions
     */
    function claimEarnings() external nonReentrant {
        uint256[] storage positions = userPositions[msg.sender];
        require(positions.length > 0, "No positions");

        uint256 totalUnclaimed = 0;

        for (uint256 i = 0; i < positions.length; i++) {
            uint256 posId = positions[i];
            Lobster storage lob = lobsters[posId];

            uint256 accumulated = (accEarningsPerPosition - lob.earningsDebt) / PRECISION;
            uint256 unclaimed = accumulated - lob.claimedAmount;

            if (unclaimed > 0) {
                lob.claimedAmount = accumulated;
                totalUnclaimed += unclaimed;
            }
        }

        require(totalUnclaimed > 0, "Nothing to claim");
        clawdToken.safeTransfer(msg.sender, totalUnclaimed);

        emit EarningsClaimed(msg.sender, totalUnclaimed);
    }

    // ============ View Functions ============

    /**
     * @notice Get unclaimed earnings for a single position
     */
    function getUnclaimedForPosition(uint256 posId) public view returns (uint256) {
        Lobster storage lob = lobsters[posId];
        if (lob.owner == address(0)) return 0;
        uint256 accumulated = (accEarningsPerPosition - lob.earningsDebt) / PRECISION;
        return accumulated - lob.claimedAmount;
    }

    /**
     * @notice Get total unclaimed earnings for a user across all positions
     */
    function getUnclaimedEarnings(address user) external view returns (uint256) {
        uint256[] storage positions = userPositions[user];
        uint256 total = 0;
        for (uint256 i = 0; i < positions.length; i++) {
            total += getUnclaimedForPosition(positions[i]);
        }
        return total;
    }

    /**
     * @notice Get all position IDs for a user
     */
    function getUserPositions(address user) external view returns (uint256[] memory) {
        return userPositions[user];
    }

    /**
     * @notice Get stack stats
     */
    function getStackStats()
        external
        view
        returns (
            uint256 _totalLobsters,
            uint256 _entryCost,
            uint256 _totalBurned,
            uint256 _totalPaidOut,
            uint256 _rewardPool
        )
    {
        return (totalLobsters, entryCost, totalBurned, totalPaidOut, rewardPool);
    }

    /**
     * @notice Get a single lobster by position
     */
    function getLobster(uint256 position)
        external
        view
        returns (
            address owner,
            uint256 enteredAt,
            uint256 pos,
            uint256 unclaimed
        )
    {
        Lobster storage lob = lobsters[position];
        return (
            lob.owner,
            lob.enteredAt,
            lob.position,
            getUnclaimedForPosition(position)
        );
    }

    /**
     * @notice Get lobsters (paginated)
     */
    function getLobsters(uint256 offset, uint256 limit)
        external
        view
        returns (
            address[] memory owners,
            uint256[] memory enteredAts,
            uint256[] memory positions,
            uint256[] memory unclaimeds
        )
    {
        uint256 end = offset + limit;
        if (end > totalLobsters) end = totalLobsters;
        uint256 count = end > offset ? end - offset : 0;

        owners = new address[](count);
        enteredAts = new uint256[](count);
        positions = new uint256[](count);
        unclaimeds = new uint256[](count);

        for (uint256 i = 0; i < count; i++) {
            uint256 posId = offset + i + 1; // 1-indexed
            Lobster storage lob = lobsters[posId];
            owners[i] = lob.owner;
            enteredAts[i] = lob.enteredAt;
            positions[i] = lob.position;
            unclaimeds[i] = getUnclaimedForPosition(posId);
        }
    }

    // ============ Admin Functions ============

    /**
     * @notice Update entry cost
     */
    function setEntryCost(uint256 newCost) external onlyOwner {
        uint256 oldCost = entryCost;
        entryCost = newCost;
        emit EntryCostUpdated(oldCost, newCost);
    }

    /**
     * @notice Update distribution BPS
     */
    function setDistribution(
        uint256 _participantBps,
        uint256 _burnBps,
        uint256 _instantRewardBps
    ) external onlyOwner {
        require(
            _participantBps + _burnBps + _instantRewardBps <= BPS_DENOMINATOR,
            "BPS exceeds 100%"
        );
        participantBps = _participantBps;
        burnBps = _burnBps;
        instantRewardBps = _instantRewardBps;
        emit DistributionUpdated(_participantBps, _burnBps, _instantRewardBps);
    }

    /**
     * @notice Pause/unpause
     */
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseUpdated(_paused);
    }

    /**
     * @notice Withdraw from reward pool
     */
    function withdrawRewardPool(uint256 amount) external onlyOwner nonReentrant {
        require(amount <= rewardPool, "Exceeds pool");
        rewardPool -= amount;
        clawdToken.safeTransfer(msg.sender, amount);
        emit RewardPoolWithdrawn(msg.sender, amount);
    }
}
