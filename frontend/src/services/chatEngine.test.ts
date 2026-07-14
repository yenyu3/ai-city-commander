import { describe, expect, it } from "vitest";
import { runWhatIf } from "./chatEngine";

describe("runWhatIf number parsing", () => {
  it("does not mistake the '17' in BL17 for the user count", () => {
    const { ruleResult } = runWhatIf("若 BL17 人數增加到 40000 人會怎樣？") as {
      ruleResult: { input: { userCount: number } };
    };
    expect(ruleResult.input.userCount).toBe(40000);
  });

  it("still triggers mrt diversion once the real count is parsed", () => {
    const { ruleResult } = runWhatIf("若 BL17 人數增加到 40000 人會怎樣？") as {
      ruleResult: { triggered: boolean };
    };
    expect(ruleResult.triggered).toBe(true);
  });
});
