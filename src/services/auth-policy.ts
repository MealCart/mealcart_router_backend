export type UserRole = "admin" | "staff";
export function allowedUser(user: { role: string; status: string }): boolean {
  return (user.role === "admin" || user.role === "staff") && user.status === "active";
}
export function bcryptHash(hash: string): string | null {
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) return null;
  const cost = Number(hash.slice(4, 6));
  if (cost < 4 || cost > 16) return null;
  return hash.startsWith("$2y$") ? "$2b$" + hash.slice(4) : hash;
}
