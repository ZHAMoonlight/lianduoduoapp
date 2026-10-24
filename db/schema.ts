import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { WorkspaceData } from "../lib/types";

// 每个认证所有者一份私有体验空间。单行版本 CAS 使预约/扣课/清分同生共灭。
export const workspaces = sqliteTable("workspaces", {
  owner: text("owner").primaryKey(),
  data: text("data", { mode: "json" }).$type<WorkspaceData>().notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});
