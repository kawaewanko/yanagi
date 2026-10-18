import { describe, expect, it } from "vitest";
import { auditChanges } from "./audit-events.js";

describe("auditChanges", () => {
  it("returns changed fields with before and after values", () => {
    expect(
      auditChanges(
        { name: "old-name", topic: null, roleIds: ["role-a"] },
        { name: "new-name", topic: null, roleIds: ["role-a", "role-b"] },
      ),
    ).toEqual({
      name: { before: "old-name", after: "new-name" },
      roleIds: { before: ["role-a"], after: ["role-a", "role-b"] },
    });
  });

  it("ignores unchanged fields and returns null when there are no changes", () => {
    expect(
      auditChanges(
        { name: "channel", roleIds: ["role-a"] },
        {
          name: "channel",
          roleIds: ["role-a"],
        },
      ),
    ).toBeNull();
  });

  it("records fields added or removed from a snapshot", () => {
    expect(auditChanges({ topic: "old topic" }, {})).toEqual({
      topic: { before: "old topic", after: null },
    });
  });
});
