import { beforeEach, describe, expect, it } from "vitest";

import {
  clearGatewayAuthToken,
  getGatewayAuthToken,
  setGatewayAuthToken,
} from "../packages/web/utils/authToken";

describe("gateway auth token memory store", () => {
  beforeEach(() => {
    clearGatewayAuthToken();
  });

  it("keeps the token only in process memory", () => {
    expect(getGatewayAuthToken()).toBeNull();

    setGatewayAuthToken("abc123");
    expect(getGatewayAuthToken()).toBe("abc123");

    clearGatewayAuthToken();
    expect(getGatewayAuthToken()).toBeNull();
  });
});
