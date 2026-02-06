"use client";

import { useEffect, useState } from "react";
import "./lobster.css";
import { Address } from "@scaffold-ui/components";
import { formatUnits } from "viem";
import { base } from "viem/chains";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useSwitchChain } from "wagmi";
import { useScaffoldEventHistory, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import scaffoldConfig from "~~/scaffold.config";

// Helper to format large CLAWD amounts
function formatClawd(value: bigint | undefined): string {
  if (!value) return "0";
  const num = Number(formatUnits(value, 18));
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toFixed(0);
}

function formatClawdFull(value: bigint | undefined): string {
  if (!value) return "0";
  return Number(formatUnits(value, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatUsd(clawd: bigint | undefined, price: number | null): string {
  if (!clawd || !price) return "";
  const usd = Number(formatUnits(clawd, 18)) * price;
  if (usd < 0.01) return "";
  if (usd >= 1000) return `(~$${(usd / 1000).toFixed(1)}K)`;
  return `(~$${usd.toFixed(2)})`;
}

export default function LobsterStackPage() {
  const { address: connectedAddress, chain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { openConnectModal } = useConnectModal();
  const targetNetwork = scaffoldConfig.targetNetworks[0];
  const isWrongNetwork = connectedAddress && chain && chain.id !== targetNetwork.id;
  const [isSwitching, setIsSwitching] = useState(false);
  const [clawdPrice, setClawdPrice] = useState<number | null>(null);

  // Fetch CLAWD price from DexScreener
  useEffect(() => {
    fetch("https://api.dexscreener.com/latest/dex/tokens/0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07")
      .then(r => r.json())
      .then(d => {
        const p = d?.pairs?.[0]?.priceUsd;
        if (p) setClawdPrice(parseFloat(p));
      })
      .catch(() => {});
  }, []);

  // ============ Read contract state ============
  const { data: stackStats } = useScaffoldReadContract({
    contractName: "LobsterStack",
    functionName: "getStackStats",
  });

  const { data: entryCost } = useScaffoldReadContract({
    contractName: "LobsterStack",
    functionName: "entryCost",
  });

  const { data: clawdBalance } = useScaffoldReadContract({
    contractName: "CLAWD",
    functionName: "balanceOf",
    args: [connectedAddress],
    query: { enabled: !!connectedAddress },
  });

  const { data: userPositions } = useScaffoldReadContract({
    contractName: "LobsterStack",
    functionName: "getUserPositions",
    args: [connectedAddress],
    query: { enabled: !!connectedAddress },
  });

  const { data: unclaimedEarnings } = useScaffoldReadContract({
    contractName: "LobsterStack",
    functionName: "getUnclaimedEarnings",
    args: [connectedAddress],
    query: { enabled: !!connectedAddress },
  });

  // Get lobsters for display (latest 20)
  const totalLobsters = stackStats ? stackStats[0] : 0n;
  const displayOffset = totalLobsters > 20n ? totalLobsters - 20n : 0n;
  const displayLimit = totalLobsters > 20n ? 20n : totalLobsters;

  const { data: lobsterData } = useScaffoldReadContract({
    contractName: "LobsterStack",
    functionName: "getLobsters",
    args: [displayOffset, displayLimit],
    query: { enabled: totalLobsters > 0n },
  });

  // Event history — use a recent block to avoid scanning all of Base history
  const { data: entryEvents } = useScaffoldEventHistory({
    contractName: "LobsterStack",
    eventName: "LobsterEntered",
    fromBlock: 41775750n,
    watch: true,
  });

  // ============ Write hooks ============
  const { writeContractAsync: writeCLAWD, isMining: isCLAWDMining } = useScaffoldWriteContract("CLAWD");
  const { writeContractAsync: writeLobsterStack, isMining: isStackMining } = useScaffoldWriteContract("LobsterStack");

  // ============ Local UI state ============
  const [isApproving, setIsApproving] = useState(false);
  const [isEntering, setIsEntering] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  const [isMinting, setIsMinting] = useState(false);
  const [approveDisableTimer, setApproveDisableTimer] = useState(false);
  const [enterDisableTimer, setEnterDisableTimer] = useState(false);
  const [claimDisableTimer, setClaimDisableTimer] = useState(false);

  const isAnyMining = isCLAWDMining || isStackMining;

  // For allowance, we need the actual LobsterStack contract address.
  // The scaffold system knows it. Let's use the raw deployed contract address.
  // We can get it by importing deployedContracts
  const [lobsterStackAddr, setLobsterStackAddr] = useState<`0x${string}` | undefined>();

  useEffect(() => {
    // Get address from deployedContracts for the current target network
    import("~~/contracts/deployedContracts").then(mod => {
      const contracts = mod.default;
      // Try current target network first, then fallback to any chain that has LobsterStack
      const chainIds = [targetNetwork.id, 8453, 31337];
      for (const cid of chainIds) {
        const chain = contracts[cid as keyof typeof contracts];
        if (chain && "LobsterStack" in chain) {
          setLobsterStackAddr((chain as any).LobsterStack.address as `0x${string}`);
          break;
        }
      }
    });
  }, [targetNetwork.id]);

  // Real allowance read with the actual contract address
  const { data: realAllowance } = useScaffoldReadContract({
    contractName: "CLAWD",
    functionName: "allowance",
    args: [connectedAddress, lobsterStackAddr],
    query: { enabled: !!connectedAddress && !!lobsterStackAddr },
  });

  const hasEnoughAllowance = realAllowance !== undefined && entryCost !== undefined && realAllowance >= entryCost;
  const hasEnoughBalance = clawdBalance !== undefined && entryCost !== undefined && clawdBalance >= entryCost;

  // ============ Handlers ============
  const handleMintTestTokens = async () => {
    if (!connectedAddress) return;
    setIsMinting(true);
    try {
      await writeCLAWD({
        functionName: "mint",
        args: [connectedAddress, BigInt("10000000000000000000000000")], // 10M CLAWD
      });
    } catch (e) {
      console.error("Mint failed:", e);
    } finally {
      setIsMinting(false);
    }
  };

  const handleApprove = async () => {
    if (!lobsterStackAddr || !entryCost) return;
    setIsApproving(true);
    setApproveDisableTimer(true);
    setTimeout(() => setApproveDisableTimer(false), 3000);
    try {
      await writeCLAWD({
        functionName: "approve",
        args: [lobsterStackAddr, entryCost],
      });
    } catch (e) {
      console.error("Approve failed:", e);
    } finally {
      setIsApproving(false);
    }
  };

  const handleEnterStack = async () => {
    setIsEntering(true);
    setEnterDisableTimer(true);
    setTimeout(() => setEnterDisableTimer(false), 3000);
    try {
      await writeLobsterStack({
        functionName: "enterStack",
      });
    } catch (e) {
      console.error("Enter failed:", e);
    } finally {
      setIsEntering(false);
    }
  };

  const handleClaim = async () => {
    setIsClaiming(true);
    setClaimDisableTimer(true);
    setTimeout(() => setClaimDisableTimer(false), 3000);
    try {
      await writeLobsterStack({
        functionName: "claimEarnings",
      });
    } catch (e) {
      console.error("Claim failed:", e);
    } finally {
      setIsClaiming(false);
    }
  };

  // Parse stats
  const stats = {
    totalLobsters: stackStats ? Number(stackStats[0]) : 0,
    entryCost: stackStats ? stackStats[1] : 0n,
    totalBurned: stackStats ? stackStats[2] : 0n,
    totalPaidOut: stackStats ? stackStats[3] : 0n,
    rewardPool: stackStats ? stackStats[4] : 0n,
  };

  // Parse lobster data for display
  const lobstersForDisplay = lobsterData
    ? lobsterData[0].map((owner: string, i: number) => ({
        owner: owner as `0x${string}`,
        enteredAt: Number(lobsterData[1][i]),
        position: Number(lobsterData[2][i]),
        unclaimed: lobsterData[3][i],
      }))
    : [];

  // Reverse so newest is on top
  const lobstersReversed = [...lobstersForDisplay].reverse();

  // Recent events (last 10)
  const recentEvents = (entryEvents || []).slice(0, 10);

  return (
    <div className="lobster-page">
      {/* Stats Bar */}
      <div className="stats-bar">
        <div className="stat-item">
          <div className="stat-value">{stats.totalLobsters}</div>
          <div className="stat-label">🦞 Lobsters</div>
        </div>
        <div className="stat-item">
          <div className="stat-value stat-burn">{formatClawd(stats.totalBurned)}</div>
          <div className="stat-label">🔥 Burned</div>
        </div>
        <div className="stat-item">
          <div className="stat-value stat-gold">{formatClawd(stats.totalPaidOut)}</div>
          <div className="stat-label">💰 Paid Out</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{formatClawd(stats.entryCost)}</div>
          <div className="stat-label">🎟️ Entry Cost</div>
        </div>
      </div>

      <div className="main-content">
        {/* Left: Stack Visualization */}
        <div className="stack-section">
          <h2 className="section-title">The Stack</h2>
          <div className="stack-container">
            {lobstersReversed.length === 0 ? (
              <div className="empty-stack">
                <div className="empty-lobster">🦞</div>
                <p>No lobsters yet. Be the first!</p>
              </div>
            ) : (
              lobstersReversed.map((lob, i) => {
                const isOwn = connectedAddress && lob.owner.toLowerCase() === connectedAddress.toLowerCase();
                return (
                  <div
                    key={lob.position}
                    className={`lobster-card ${isOwn ? "lobster-own" : ""} ${i === 0 ? "lobster-newest" : ""}`}
                  >
                    <span className="lobster-emoji">🦞</span>
                    <span className="lobster-position">#{lob.position}</span>
                    <span className="lobster-address">
                      <Address address={lob.owner} />
                    </span>
                    <span className="lobster-earnings">{formatClawd(lob.unclaimed)} CLAWD</span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Action + User panels */}
        <div className="action-section">
          {/* Action Panel */}
          <div className="panel action-panel">
            <h2 className="section-title">Enter the Stack</h2>

            {connectedAddress && <div className="balance-display">Balance: {formatClawdFull(clawdBalance)} CLAWD {formatUsd(clawdBalance, clawdPrice)}</div>}

            {!connectedAddress ? (
              <button
                className="btn-action btn-enter"
                onClick={openConnectModal}
              >
                Connect Wallet to Enter 🦞
              </button>
            ) : isWrongNetwork ? (
              <button
                className="btn-action btn-enter"
                disabled={isSwitching || isAnyMining}
                onClick={async () => {
                  setIsSwitching(true);
                  try {
                    await switchChainAsync({ chainId: targetNetwork.id });
                  } catch (e) {
                    console.error("Switch failed:", e);
                  } finally {
                    setIsSwitching(false);
                  }
                }}
              >
                {isSwitching ? (
                  <>
                    <span className="spinner" /> Switching...
                  </>
                ) : (
                  `Switch to ${targetNetwork.name}`
                )}
              </button>
            ) : !hasEnoughBalance ? (
              <div className="no-balance">
                <p>You need {formatClawd(entryCost)} CLAWD {formatUsd(entryCost, clawdPrice)} to enter</p>
                {targetNetwork.id === 31337 && (
                  <button
                    className="btn-action btn-mint"
                    disabled={isMinting || isAnyMining}
                    onClick={handleMintTestTokens}
                  >
                    {isMinting ? "Minting..." : "Mint 10M Test CLAWD"}
                  </button>
                )}
                {targetNetwork.id !== 31337 && (
                  <a
                    href="https://app.uniswap.org/swap?outputCurrency=0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07&chain=base"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-action btn-mint"
                  >
                    Get $CLAWD on Uniswap ↗
                  </a>
                )}
              </div>
            ) : !hasEnoughAllowance ? (
              <button
                className="btn-action btn-approve"
                disabled={isApproving || approveDisableTimer || isAnyMining}
                onClick={handleApprove}
              >
                {isApproving ? (
                  <>
                    <span className="spinner" /> Approving...
                  </>
                ) : (
                  `Approve ${formatClawd(entryCost)} CLAWD`
                )}
              </button>
            ) : (
              <button
                className="btn-action btn-enter"
                disabled={isEntering || enterDisableTimer || isAnyMining}
                onClick={handleEnterStack}
              >
                {isEntering ? (
                  <>
                    <span className="spinner" /> Entering...
                  </>
                ) : (
                  "Enter the Stack 🦞"
                )}
              </button>
            )}

            <div className="distribution-info">
              <span>60% to stack</span>
              <span>20% burned</span>
              <span>20% instant reward</span>
            </div>
          </div>

          {/* User Positions */}
          {connectedAddress && userPositions && userPositions.length > 0 && (
            <div className="panel positions-panel">
              <h2 className="section-title">Your Positions</h2>
              <div className="unclaimed-total">
                <span className="unclaimed-label">Unclaimed Earnings</span>
                <span className="unclaimed-value">{formatClawdFull(unclaimedEarnings)} CLAWD {formatUsd(unclaimedEarnings, clawdPrice)}</span>
              </div>
              <div className="positions-list">
                {userPositions.map(posId => (
                  <div key={Number(posId)} className="position-item">
                    <span className="position-number">🦞 #{Number(posId)}</span>
                  </div>
                ))}
              </div>
              {unclaimedEarnings && unclaimedEarnings > 0n && (
                <button
                  className="btn-action btn-claim"
                  disabled={isClaiming || claimDisableTimer || isAnyMining}
                  onClick={handleClaim}
                >
                  {isClaiming ? (
                    <>
                      <span className="spinner" /> Claiming...
                    </>
                  ) : (
                    `Claim ${formatClawdFull(unclaimedEarnings)} CLAWD`
                  )}
                </button>
              )}
            </div>
          )}

          {/* Recent Activity */}
          <div className="panel activity-panel">
            <h2 className="section-title">Recent Activity</h2>
            {recentEvents.length === 0 ? (
              <p className="no-activity">No entries yet</p>
            ) : (
              <div className="activity-list">
                {recentEvents.map((event, i) => (
                  <div key={i} className="activity-item">
                    <span>🦞</span>
                    <Address address={event.args.owner as `0x${string}`} />
                    <span>entered at #{Number(event.args.position)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Info Section */}
          <div className="panel info-panel">
            <h2 className="section-title">How It Works</h2>
            <ol className="how-it-works">
              <li>Pay CLAWD to enter the stack</li>
              <li>60% of each new entry goes to existing lobsters</li>
              <li>20% is burned forever 🔥</li>
              <li>20% comes back to you instantly as a welcome reward</li>
              <li>Earlier positions earn from every future entry</li>
              <li>Claim your earnings anytime</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
