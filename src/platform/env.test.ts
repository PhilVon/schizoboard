import { describe, expect, it } from "vitest";

import { host, isTauri } from "@/platform/env";

describe("platform/env", () => {
  it("reports the browser host when no Tauri bridge is present", () => {
    expect(host()).toBe("browser");
    expect(isTauri()).toBe(false);
  });
});
