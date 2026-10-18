export type AuditValue = string | number | boolean | null | string[];
export type AuditSnapshot = Record<string, AuditValue>;
export type AuditChanges = Record<
  string,
  { before: AuditValue; after: AuditValue }
>;

export function auditChanges(
  before: AuditSnapshot,
  after: AuditSnapshot,
): AuditChanges | null {
  const changes: AuditChanges = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldValue = before[key];
    const newValue = after[key];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes[key] = {
        before: oldValue === undefined ? null : oldValue,
        after: newValue === undefined ? null : newValue,
      };
    }
  }
  return Object.keys(changes).length ? changes : null;
}
