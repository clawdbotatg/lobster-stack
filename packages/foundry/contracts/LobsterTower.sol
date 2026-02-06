// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title LobsterTower
 * @notice Stack lobsters on a tower. Each entry has a 1-in-50 chance to topple
 * the tower and win the pot. Uses commit-reveal with blockhash for randomness.
 *
 * Flow:
 * 1. Player calls enterTower(commit) with commit = keccak256(reveal)
 * 2. 80% distributed to existing lobsters, 10% burned, 10% to pot
 * 3. After the commit block mines, frontend checks if reveal + blockhash is lucky
 * 4. If lucky (hash % 50 == 0), player calls topple(reveal) to win the pot
 * 5. Tower resets. Unclaimed earnings from 80% share remain claimable.
 */
contract LobsterTower is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 private constant PRECISION = 1e18;
    uint256 public constant TOPPLE_MODULO = 69; // 1 in 69 chance
    uint256 public constant REVEAL_WINDOW = 255; // blocks to reveal

    // ============ Immutables ============
    IERC20 public immutable clawdToken;

    // ============ Configuration ============
    uint256 public entryCost;           // e.g., 100 * 1e18 = 100 CLAWD
    uint256 public participantBps;      // 8000 = 80%
    uint256 public burnBps;             // 1000 = 10%
    // Remaining = pot BPS: BPS_DENOMINATOR - participantBps - burnBps

    // ============ Tower State ============
    uint256 public towerHeight;         // current number of lobsters
    uint256 public towerRound;          // increments on topple
    bool public paused;

    // Masterchef accumulator for the 80% share
    uint256 public accEarningsPerLobster;

    struct Lobster {
        address owner;
        uint256 enteredAt;
        uint256 round;          // which round this lobster was placed
        uint256 earningsDebt;   // masterchef debt snapshot
        uint256 claimedAmount;
    }

    // Global position counter (never resets)
    uint256 public nextLobsterId;

    // positionId => Lobster
    mapping(uint256 => Lobster) public lobsters;

    // user => list of positionIds
    mapping(address => uint256[]) public userPositions;

    // Commit-reveal state per entry
    struct Commit {
        bytes32 commitHash;     // keccak256(reveal)
        uint256 commitBlock;    // block number when committed
        address committer;      // who committed
        bool revealed;          // whether already revealed/expired
    }

    // positionId => Commit (each entry has one commit)
    mapping(uint256 => Commit) public commits;

    // ============ Pot ============
    uint256 public pot;

    // ============ Stats ============
    uint256 public totalBurned;
    uint256 public totalPaidOut;
    uint256 public totalToppled;

    // ============ Events ============
    event LobsterPlaced(uint256 indexed positionId, address indexed owner, uint256 amount, uint256 round);
    event TowerToppled(uint256 indexed round, address indexed toppler, uint256 potWon, uint256 height);
    event EarningsClaimed(address indexed user, uint256 amount);
    event DistributionUpdated(uint256 participantBps, uint256 burnBps);
    event EntryCostUpdated(uint256 oldCost, uint256 newCost);
    event PauseUpdated(bool paused);

    // ============ Modifiers ============
    modifier whenNotPaused() {
        require(!paused, "LobsterTower: paused");
        _;
    }

    // ============ Constructor ============
    constructor(
        address _clawdToken,
        uint256 _entryCost,
        uint256 _participantBps,
        uint256 _burnBps
    ) Ownable(msg.sender) {
        require(_clawdToken != address(0), "Invalid token");
        require(_participantBps + _burnBps <= BPS_DENOMINATOR, "BPS exceeds 100%");

        clawdToken = IERC20(_clawdToken);
        entryCost = _entryCost;
        participantBps = _participantBps;
        burnBps = _burnBps;
    }

    // ============ Core Functions ============

    /**
     * @notice Place a lobster on the tower with a commit for the topple lottery.
     * @param commit keccak256(reveal) where reveal is a random bytes32
     */
    function enterTower(bytes32 commit) external nonReentrant whenNotPaused {
        require(entryCost > 0, "Entry cost not set");
        require(commit != bytes32(0), "Invalid commit");

        // 1. Transfer CLAWD from user
        clawdToken.safeTransferFrom(msg.sender, address(this), entryCost);

        // 2. Calculate splits
        uint256 participantShare = (entryCost * participantBps) / BPS_DENOMINATOR;
        uint256 burnAmount = (entryCost * burnBps) / BPS_DENOMINATOR;
        uint256 potAmount = entryCost - participantShare - burnAmount;

        // 3. Update accumulator for existing lobsters
        if (towerHeight > 0) {
            accEarningsPerLobster += (participantShare * PRECISION) / towerHeight;
            totalPaidOut += participantShare;
        } else {
            // First lobster — participant share goes to pot
            potAmount += participantShare;
        }

        // 4. Burn
        if (burnAmount > 0) {
            clawdToken.safeTransfer(DEAD, burnAmount);
            totalBurned += burnAmount;
        }

        // 5. Add to pot
        pot += potAmount;

        // 6. Create position
        nextLobsterId++;
        uint256 posId = nextLobsterId;
        towerHeight++;

        lobsters[posId] = Lobster({
            owner: msg.sender,
            enteredAt: block.timestamp,
            round: towerRound,
            earningsDebt: accEarningsPerLobster,
            claimedAmount: 0
        });

        userPositions[msg.sender].push(posId);

        // 7. Store commit
        commits[posId] = Commit({
            commitHash: commit,
            commitBlock: block.number,
            committer: msg.sender,
            revealed: false
        });

        emit LobsterPlaced(posId, msg.sender, entryCost, towerRound);
    }

    /**
     * @notice Check if a reveal would topple the tower (view function for frontend).
     * @param positionId The position that committed
     * @param reveal The secret reveal value
     * @return canTopple Whether this reveal wins the lottery
     * @return blockHash The commit block's hash (0 if expired)
     */
    function checkTopple(uint256 positionId, bytes32 reveal) external view returns (bool canTopple, bytes32 blockHash) {
        Commit storage c = commits[positionId];
        require(c.commitHash != bytes32(0), "No commit");
        require(!c.revealed, "Already revealed");
        require(keccak256(abi.encodePacked(reveal)) == c.commitHash, "Bad reveal");

        blockHash = blockhash(c.commitBlock);
        if (blockHash == bytes32(0)) {
            // Blockhash expired (>255 blocks) or same block
            return (false, bytes32(0));
        }

        uint256 roll = uint256(keccak256(abi.encodePacked(reveal, blockHash))) % TOPPLE_MODULO;
        canTopple = (roll == 0);
    }

    /**
     * @notice Topple the tower! Reveal your commit to prove you won the lottery.
     * @param positionId The position ID that committed
     * @param reveal The secret reveal value
     */
    function topple(uint256 positionId, bytes32 reveal) external nonReentrant {
        Commit storage c = commits[positionId];
        require(c.commitHash != bytes32(0), "No commit");
        require(!c.revealed, "Already revealed");
        require(c.committer == msg.sender, "Not your commit");
        require(keccak256(abi.encodePacked(reveal)) == c.commitHash, "Bad reveal");

        bytes32 blockHash = blockhash(c.commitBlock);
        require(blockHash != bytes32(0), "Blockhash expired");
        require(block.number > c.commitBlock, "Same block");

        uint256 roll = uint256(keccak256(abi.encodePacked(reveal, blockHash))) % TOPPLE_MODULO;
        require(roll == 0, "Not a winning roll");

        c.revealed = true;

        // Tower topples!
        uint256 potWon = pot;
        uint256 height = towerHeight;
        pot = 0;
        towerHeight = 0;
        towerRound++;
        totalToppled++;

        // Send pot to toppler
        if (potWon > 0) {
            clawdToken.safeTransfer(msg.sender, potWon);
        }

        emit TowerToppled(towerRound - 1, msg.sender, potWon, height);
    }

    /**
     * @notice Mark a commit as expired (anyone can call after 255 blocks).
     * @param positionId The position with the expired commit
     */
    function expireCommit(uint256 positionId) external {
        Commit storage c = commits[positionId];
        require(c.commitHash != bytes32(0), "No commit");
        require(!c.revealed, "Already revealed");
        require(block.number > c.commitBlock + REVEAL_WINDOW, "Not expired yet");
        c.revealed = true;
    }

    // ============ Earnings Functions ============

    /**
     * @notice Get unclaimed earnings for a position
     */
    function getUnclaimedForPosition(uint256 positionId) public view returns (uint256) {
        Lobster storage l = lobsters[positionId];
        if (l.owner == address(0)) return 0;

        uint256 accumulated = (accEarningsPerLobster - l.earningsDebt) / PRECISION;
        return accumulated - l.claimedAmount;
    }

    /**
     * @notice Get total unclaimed earnings for a user across all positions
     */
    function getUnclaimedEarnings(address user) public view returns (uint256) {
        uint256[] storage positions = userPositions[user];
        uint256 total = 0;
        for (uint256 i = 0; i < positions.length; i++) {
            total += getUnclaimedForPosition(positions[i]);
        }
        return total;
    }

    /**
     * @notice Claim all unclaimed earnings across all positions
     */
    function claimEarnings() external nonReentrant {
        uint256[] storage positions = userPositions[msg.sender];
        require(positions.length > 0, "No positions");

        uint256 totalClaim = 0;
        for (uint256 i = 0; i < positions.length; i++) {
            uint256 posId = positions[i];
            uint256 unclaimed = getUnclaimedForPosition(posId);
            if (unclaimed > 0) {
                lobsters[posId].claimedAmount += unclaimed;
                totalClaim += unclaimed;
            }
        }

        require(totalClaim > 0, "Nothing to claim");
        clawdToken.safeTransfer(msg.sender, totalClaim);

        emit EarningsClaimed(msg.sender, totalClaim);
    }

    // ============ View Functions ============

    function getTowerStats() external view returns (
        uint256 _height,
        uint256 _round,
        uint256 _pot,
        uint256 _entryCost,
        uint256 _totalBurned,
        uint256 _totalPaidOut,
        uint256 _totalToppled
    ) {
        return (towerHeight, towerRound, pot, entryCost, totalBurned, totalPaidOut, totalToppled);
    }

    function getUserPositions(address user) external view returns (uint256[] memory) {
        return userPositions[user];
    }

    // ============ Hash Helper Functions (so frontend never computes hashes off-chain) ============

    /**
     * @notice Compute the commit hash for a given reveal. Frontend uses this to generate commits.
     * @param reveal The secret random bytes32
     * @return commitHash keccak256(abi.encodePacked(reveal))
     */
    function computeCommit(bytes32 reveal) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(reveal));
    }

    /**
     * @notice Compute the roll value for a reveal + blockhash combo.
     * @param reveal The secret random bytes32
     * @param blockHash The blockhash of the commit block
     * @return roll The roll result (0 to TOPPLE_MODULO-1). Roll == 0 means winner!
     */
    function computeRoll(bytes32 reveal, bytes32 blockHash) external pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(reveal, blockHash))) % TOPPLE_MODULO;
    }

    /**
     * @notice Check if a reveal + blockhash combo is a winning roll.
     * @param reveal The secret random bytes32
     * @param blockHash The blockhash of the commit block
     * @return winner True if roll == 0 (1 in TOPPLE_MODULO chance)
     */
    function isWinningRoll(bytes32 reveal, bytes32 blockHash) external pure returns (bool) {
        return uint256(keccak256(abi.encodePacked(reveal, blockHash))) % TOPPLE_MODULO == 0;
    }

    /**
     * @notice Get the blockhash for a given block number. Returns bytes32(0) if expired (>255 blocks ago).
     * @param blockNumber The block number to look up
     * @return blockHash The blockhash (or 0 if unavailable)
     */
    function getBlockHash(uint256 blockNumber) external view returns (bytes32) {
        return blockhash(blockNumber);
    }

    /**
     * @notice Full check for a position: given reveal, returns whether it's a winner and all relevant data.
     * @param positionId The position that committed
     * @param reveal The secret reveal value
     * @return winner Whether this is a winning topple
     * @return roll The roll value (0 = winner)
     * @return blockHash The commit block's hash
     * @return blocksRemaining Blocks left in the reveal window (0 if expired)
     */
    function fullCheck(uint256 positionId, bytes32 reveal) external view returns (
        bool winner,
        uint256 roll,
        bytes32 blockHash,
        uint256 blocksRemaining
    ) {
        Commit storage c = commits[positionId];
        require(c.commitHash != bytes32(0), "No commit");
        require(keccak256(abi.encodePacked(reveal)) == c.commitHash, "Bad reveal");

        blockHash = blockhash(c.commitBlock);
        if (blockHash == bytes32(0)) {
            return (false, 0, bytes32(0), 0);
        }

        roll = uint256(keccak256(abi.encodePacked(reveal, blockHash))) % TOPPLE_MODULO;
        winner = (roll == 0);

        uint256 deadline = c.commitBlock + REVEAL_WINDOW;
        blocksRemaining = block.number <= deadline ? deadline - block.number : 0;
    }

    function getCommitInfo(uint256 positionId) external view returns (
        bytes32 commitHash,
        uint256 commitBlock,
        address committer,
        bool revealed,
        bool expired
    ) {
        Commit storage c = commits[positionId];
        expired = (block.number > c.commitBlock + REVEAL_WINDOW) && !c.revealed;
        return (c.commitHash, c.commitBlock, c.committer, c.revealed, expired);
    }

    // ============ Admin Functions ============

    function setEntryCost(uint256 newCost) external onlyOwner {
        uint256 oldCost = entryCost;
        entryCost = newCost;
        emit EntryCostUpdated(oldCost, newCost);
    }

    function setDistribution(uint256 _participantBps, uint256 _burnBps) external onlyOwner {
        require(_participantBps + _burnBps <= BPS_DENOMINATOR, "BPS exceeds 100%");
        participantBps = _participantBps;
        burnBps = _burnBps;
        emit DistributionUpdated(_participantBps, _burnBps);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseUpdated(_paused);
    }
}
