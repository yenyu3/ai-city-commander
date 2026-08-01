export const PROFILES = {
  fast: { latencyMs: 20, jitterMs: 10, downlinkKbps: 20_000, failureRate: 0, timeoutMs: 8_000 },
  "slow-3g": { latencyMs: 400, jitterMs: 200, downlinkKbps: 400, failureRate: 0.02, timeoutMs: 20_000 },
  unstable: { latencyMs: 700, jitterMs: 500, downlinkKbps: 250, failureRate: 0.15, timeoutMs: 25_000 },
  // A busy cell near an event venue: high radio scheduling delay, scarce
  // bandwidth and intermittent retransmission failures.
  "crowded-cell": { latencyMs: 1200, jitterMs: 800, downlinkKbps: 100, failureRate: 0.12, timeoutMs: 45_000 },
  // Edge-of-coverage or a moving passenger: severe RTT/jitter, very limited
  // downstream bandwidth and frequent short disconnections.
  "coverage-edge": { latencyMs: 2500, jitterMs: 1500, downlinkKbps: 40, failureRate: 0.25, timeoutMs: 60_000 },
};
