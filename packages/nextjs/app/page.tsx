"use client";

import { useEffect, useState, useCallback } from "react";
import "./lobster.css";
import { Address } from "@scaffold-ui/components";
import { formatUnits, keccak256, encodePacked, toHex } from "viem";
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

// Generate a random bytes32
function randomBytes32(): `0x${string}` {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return toHex(arr) as `0x${string}`;
}

export default function LobsterTowerPage() {
  const { address: connectedAddress, chain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { openConnectModal } = useConnectModal();
  const targetNetwork = scaffoldConfig.targetNetworks[0];
  const isWrongNetwork = connectedAddress && chain && chain.id !== targetNetwork.id;
  const [isSwitching, setIsSwitching] = useState(false);
  const [clawdPrice, setClawdPrice] = useState<number | null>(null);

  // Commit-reveal state
  const [pendingReveal, setPendingReveal] = useState<{ positionId: bigint; reveal: `0x${string}` } | null>(null);
  const [toppleCheckResult, setToppleCheckResult] = useState<{ winner: boolean; roll: number; blocksLeft: number } | null>(null);
  const [isCheckingTopple, setIsCheckingTopple] = useState(false);
  const [isToppling, setIsToppling] = useState(false);
  const [toppleAnimation, setToppleAnimation] = useState(false);

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
  const { data: towerStats } = useScaffoldReadContract({
    contractName: "LobsterTower",
    functionName: "getTowerStats",
  });

  const { data: entryCost } = useScaffoldReadContract({
    contractName: "LobsterTower",
    functionName: "entryCost",
  });

  const { data: clawdBalance } = useScaffoldReadContract({
    contractName: "CLAWD",
    functionName: "balanceOf",
    args: [connectedAddress],
    query: { enabled: !!connectedAddress },
  });

  const { data: userPositions } = useScaffoldReadContract({
    contractName: "LobsterTower",
    functionName: "getUserPositions",
    args: [connectedAddress],
    query: { enabled: !!connectedAddress },
  });

  const { data: unclaimedEarnings } = useScaffoldReadContract({
    contractName: "LobsterTower",
    functionName: "getUnclaimedEarnings",
    args: [connectedAddress],
    query: { enabled: !!connectedAddress },
  });

  // Event history
  const { data: entryEvents } = useScaffoldEventHistory({
    contractName: "LobsterTower",
    eventName: "LobsterPlaced",
    fromBlock: 42500000n,
    watch: true,
  });

  const { data: toppleEvents } = useScaffoldEventHistory({
    contractName: "LobsterTower",
    eventName: "TowerToppled",
    fromBlock: 42500000n,
    watch: true,
  });

  // ============ Write hooks ============
  const { writeContractAsync: writeCLAWD, isMining: isCLAWDMining } = useScaffoldWriteContract("CLAWD");
  const { writeContractAsync: writeLobsterTower, isMining: isTowerMining } = useScaffoldWriteContract("LobsterTower");

  // ============ Local UI state ============
  const [isApproving, setIsApproving] = useState(false);
  const [isEntering, setIsEntering] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  const [approveDisableTimer, setApproveDisableTimer] = useState(false);
  const [enterDisableTimer, setEnterDisableTimer] = useState(false);
  const [claimDisableTimer, setClaimDisableTimer] = useState(false);

  const isAnyMining = isCLAWDMining || isTowerMining;

  // Get LobsterTower address for allowance check
  const [towerAddr, setTowerAddr] = useState<`0x${string}` | undefined>();

  useEffect(() => {
    import("~~/contracts/deployedContracts").then(mod => {
      const contracts = mod.default;
      const chainIds = [targetNetwork.id, 8453, 31337];
      for (const cid of chainIds) {
        const c = contracts[cid as keyof typeof contracts];
        if (c && "LobsterTower" in c) {
          setTowerAddr((c as any).LobsterTower.address as `0x${string}`);
          break;
        }
      }
    });
  }, [targetNetwork.id]);

  // Real allowance read
  const { data: realAllowance } = useScaffoldReadContract({
    contractName: "CLAWD",
    functionName: "allowance",
    args: [connectedAddress, towerAddr],
    query: { enabled: !!connectedAddress && !!towerAddr },
  });

  const hasEnoughAllowance = realAllowance !== undefined && entryCost !== undefined && realAllowance >= entryCost;
  const hasEnoughBalance = clawdBalance !== undefined && entryCost !== undefined && clawdBalance >= entryCost;

  // ============ Check topple after entry ============
  const { data: fullCheckData } = useScaffoldReadContract({
    contractName: "LobsterTower",
    functionName: "fullCheck",
    args: [pendingReveal?.positionId, pendingReveal?.reveal],
    query: { enabled: !!pendingReveal },
  });

  useEffect(() => {
    if (fullCheckData && pendingReveal) {
      const [winner, roll, , blocksRemaining] = fullCheckData;
      setToppleCheckResult({
        winner: winner as boolean,
        roll: Number(roll),
        blocksLeft: Number(blocksRemaining),
      });
      setIsCheckingTopple(false);
    }
  }, [fullCheckData, pendingReveal]);

  // ============ Handlers ============
  const handleApprove = async () => {
    if (!towerAddr || !entryCost) return;
    setIsApproving(true);
    setApproveDisableTimer(true);
    setTimeout(() => setApproveDisableTimer(false), 3000);
    try {
      await writeCLAWD({
        functionName: "approve",
        args: [towerAddr, entryCost],
      });
    } catch (e) {
      console.error("Approve failed:", e);
    } finally {
      setIsApproving(false);
    }
  };

  const handleEnterTower = async () => {
    setIsEntering(true);
    setEnterDisableTimer(true);
    setTimeout(() => setEnterDisableTimer(false), 3000);
    setToppleCheckResult(null);
    setPendingReveal(null);
    setToppleAnimation(false);

    try {
      // 1. Generate random reveal
      const reveal = randomBytes32();

      // 2. Compute commit on-chain via the contract's helper
      // Actually, we need the commit before sending the tx, so compute locally
      // keccak256(abi.encodePacked(reveal)) — for bytes32, this is just keccak256(reveal)
      const commit = keccak256(reveal);

      // 3. Enter the tower
      await writeLobsterTower({
        functionName: "enterTower",
        args: [commit],
      });

      // 4. Get the position ID (latest nextLobsterId)
      // We'll read it after tx confirms — the scaffold hook already waited
      // Use the latest total lobsters from the refreshed state
      // For now, set pending reveal — the position will be read from userPositions on next render
      setIsCheckingTopple(true);

      // Small delay for state to propagate, then get position
      setTimeout(async () => {
        try {
          // The position ID is the last one in userPositions after the tx
          // We need a fresh read — but scaffold auto-polls. Use the nextLobsterId approach
          const rpcUrl = targetNetwork.rpcUrls?.default?.http?.[0] || `https://mainnet.base.org`;
          const resp = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_call",
              params: [{
                to: towerAddr,
                data: "0xce6c3bba" // nextLobsterId() selector
              }, "latest"]
            })
          });
          const data = await resp.json();
          const posId = BigInt(data.result);
          setPendingReveal({ positionId: posId, reveal });
        } catch (e) {
          console.error("Failed to get position ID:", e);
          setIsCheckingTopple(false);
        }
      }, 2000);

    } catch (e) {
      console.error("Enter failed:", e);
      setIsCheckingTopple(false);
    } finally {
      setIsEntering(false);
    }
  };

  const handleTopple = async () => {
    if (!pendingReveal) return;
    setIsToppling(true);
    try {
      await writeLobsterTower({
        functionName: "topple",
        args: [pendingReveal.positionId, pendingReveal.reveal],
      });
      setToppleAnimation(true);
      setTimeout(() => setToppleAnimation(false), 5000);
    } catch (e) {
      console.error("Topple failed:", e);
    } finally {
      setIsToppling(false);
      setPendingReveal(null);
      setToppleCheckResult(null);
    }
  };

  const handleClaim = async () => {
    setIsClaiming(true);
    setClaimDisableTimer(true);
    setTimeout(() => setClaimDisableTimer(false), 3000);
    try {
      await writeLobsterTower({
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
    height: towerStats ? Number(towerStats[0]) : 0,
    round: towerStats ? Number(towerStats[1]) : 0,
    pot: towerStats ? towerStats[2] : 0n,
    entryCost: towerStats ? towerStats[3] : 0n,
    totalBurned: towerStats ? towerStats[4] : 0n,
    totalPaidOut: towerStats ? towerStats[5] : 0n,
    totalToppled: towerStats ? Number(towerStats[6]) : 0,
  };

  // Recent events (last 10)
  const recentEntries = (entryEvents || []).slice(0, 10);
  const recentTopples = (toppleEvents || []).slice(0, 5);

  return (
    <div className="lobster-page">
      {/* Topple Animation Overlay */}
      {toppleAnimation && (
        <div className="topple-overlay">
          <div className="topple-text">🌊 TOWER TOPPLED! 🌊</div>
          <div className="topple-lobsters">🦞🦞🦞💥🦞🦞🦞</div>
        </div>
      )}

      {/* Stats Bar */}
      <div className="stats-bar">
        <div className="stat-item">
          <div className="stat-value">{stats.height}</div>
          <div className="stat-label">🦞 Tower Height</div>
        </div>
        <div className="stat-item">
          <div className="stat-value stat-gold">{formatClawd(stats.pot)} {formatUsd(stats.pot, clawdPrice)}</div>
          <div className="stat-label">💣 Topple Pot</div>
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
          <div className="stat-value">{stats.totalToppled}</div>
          <div className="stat-label">🌊 Times Toppled</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">Round {stats.round}</div>
          <div className="stat-label">🏁 Current Round</div>
        </div>
      </div>

      <div className="main-content">
        {/* Left: Tower Visualization */}
        <div className="stack-section">
          <h2 className="section-title">The Tower</h2>
          <div className="stack-container">
            {stats.height === 0 ? (
              <div className="empty-stack">
                <div className="empty-lobster">🦞</div>
                <p>Tower is empty. Be the first to stack!</p>
              </div>
            ) : (
              <div className="tower-display">
                {Array.from({ length: Math.min(stats.height, 30) }).map((_, i) => {
                  const pos = stats.height - i;
                  return (
                    <div
                      key={i}
                      className={`lobster-card ${i === 0 ? "lobster-newest" : ""}`}
                      style={{ animationDelay: `${i * 0.05}s` }}
                    >
                      <span className="lobster-emoji">🦞</span>
                      <span className="lobster-position">#{pos}</span>
                    </div>
                  );
                })}
                {stats.height > 30 && (
                  <div className="lobster-card lobster-more">
                    <span>... {stats.height - 30} more below ...</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: Action + Panels */}
        <div className="action-section">
          {/* Action Panel */}
          <div className="panel action-panel">
            <h2 className="section-title">Stack a Lobster</h2>

            <div className="entry-cost-display">
              <span className="entry-cost-label">Entry Cost:</span>
              <span className="entry-cost-value">{formatClawdFull(entryCost)} CLAWD {formatUsd(entryCost, clawdPrice)}</span>
            </div>

            {connectedAddress && (
              <div className="balance-display">
                Balance: {formatClawdFull(clawdBalance)} CLAWD {formatUsd(clawdBalance, clawdPrice)}
              </div>
            )}

            {!connectedAddress ? (
              <button className="btn-action btn-enter" onClick={openConnectModal}>
                Connect Wallet to Stack 🦞
              </button>
            ) : isWrongNetwork ? (
              <button
                className="btn-action btn-enter"
                disabled={isSwitching || isAnyMining}
                onClick={async () => {
                  setIsSwitching(true);
                  try { await switchChainAsync({ chainId: targetNetwork.id }); }
                  catch (e) { console.error("Switch failed:", e); }
                  finally { setIsSwitching(false); }
                }}
              >
                {isSwitching ? (<><span className="spinner" /> Switching...</>) : `Switch to ${targetNetwork.name}`}
              </button>
            ) : !hasEnoughBalance ? (
              <div className="no-balance">
                <p>You need {formatClawd(entryCost)} CLAWD to enter</p>
                <a
                  href="https://app.uniswap.org/swap?outputCurrency=0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07&chain=base"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-action btn-mint"
                >
                  Get $CLAWD on Uniswap ↗
                </a>
              </div>
            ) : !hasEnoughAllowance ? (
              <button
                className="btn-action btn-approve"
                disabled={isApproving || approveDisableTimer || isAnyMining}
                onClick={handleApprove}
              >
                {isApproving ? (<><span className="spinner" /> Approving...</>) : `Approve ${formatClawd(entryCost)} CLAWD`}
              </button>
            ) : (
              <button
                className="btn-action btn-enter"
                disabled={isEntering || enterDisableTimer || isAnyMining || isCheckingTopple}
                onClick={handleEnterTower}
              >
                {isEntering ? (<><span className="spinner" /> Stacking...</>) :
                 isCheckingTopple ? (<><span className="spinner" /> Checking for topple...</>) :
                 "Stack a Lobster 🦞"}
              </button>
            )}

            <div className="distribution-info">
              <span>80% to tower</span>
              <span>10% burned</span>
              <span>10% topple pot</span>
            </div>

            {/* Topple Check Result */}
            {toppleCheckResult && (
              <div className={`topple-result ${toppleCheckResult.winner ? "topple-winner" : "topple-safe"}`}>
                {toppleCheckResult.winner ? (
                  <>
                    <div className="topple-result-title">🎉 YOU CAN TOPPLE! 🎉</div>
                    <div className="topple-result-detail">
                      Roll: {toppleCheckResult.roll}/69 — YOU WIN THE POT!
                    </div>
                    <div className="topple-result-pot">
                      Pot: {formatClawdFull(stats.pot)} CLAWD {formatUsd(stats.pot, clawdPrice)}
                    </div>
                    <button
                      className="btn-action btn-topple"
                      disabled={isToppling}
                      onClick={handleTopple}
                    >
                      {isToppling ? (<><span className="spinner" /> Toppling...</>) : "🌊 TOPPLE THE TOWER 🌊"}
                    </button>
                    <div className="topple-result-warning">
                      ⏰ {toppleCheckResult.blocksLeft} blocks left to topple!
                    </div>
                  </>
                ) : (
                  <>
                    <div className="topple-result-title">Tower stands! 🏗️</div>
                    <div className="topple-result-detail">
                      Roll: {toppleCheckResult.roll}/69 — needed 0 to topple
                    </div>
                    <div className="topple-result-sub">Your lobster is earning from future entries 💰</div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* User Positions */}
          {connectedAddress && userPositions && userPositions.length > 0 && (
            <div className="panel positions-panel">
              <h2 className="section-title">Your Lobsters</h2>
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
                  {isClaiming ? (<><span className="spinner" /> Claiming...</>) : `Claim ${formatClawdFull(unclaimedEarnings)} CLAWD`}
                </button>
              )}
            </div>
          )}

          {/* Recent Topples */}
          {recentTopples.length > 0 && (
            <div className="panel activity-panel">
              <h2 className="section-title">Recent Topples 🌊</h2>
              <div className="activity-list">
                {recentTopples.map((event, i) => (
                  <div key={i} className="activity-item topple-event">
                    <span>💥</span>
                    <Address address={event.args.toppler as `0x${string}`} />
                    <span>won {formatClawd(event.args.potWon as bigint)} CLAWD (round {Number(event.args.round)})</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent Activity */}
          <div className="panel activity-panel">
            <h2 className="section-title">Recent Activity</h2>
            {recentEntries.length === 0 ? (
              <p className="no-activity">No entries yet</p>
            ) : (
              <div className="activity-list">
                {recentEntries.map((event, i) => (
                  <div key={i} className="activity-item">
                    <span>🦞</span>
                    <Address address={event.args.owner as `0x${string}`} />
                    <span>stacked #{Number(event.args.positionId)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Info Section */}
          <div className="panel info-panel">
            <h2 className="section-title">How It Works</h2>
            <ol className="how-it-works">
              <li>Pay {formatClawd(entryCost)} CLAWD to stack a lobster on the tower</li>
              <li>80% goes to existing lobsters in the tower 💰</li>
              <li>10% is burned forever 🔥</li>
              <li>10% goes to the topple pot 💣</li>
              <li>Each entry has a <strong>1-in-69</strong> chance to topple the tower</li>
              <li>If you topple it — you win the entire pot! 🌊</li>
              <li>Tower resets. Your earned rewards are still claimable.</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
