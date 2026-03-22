/**
 * 主导航项：后续增加新功能时在此扩展 id 与标签，并在 App 中增加对应视图。
 */
export type AppViewId = "workspace" | "reports" | "reproduction";

export const PRIMARY_NAV: { id: AppViewId; label: string; description: string }[] = [
  { id: "workspace", label: "工作台", description: "文献库与阅读对话" },
  { id: "reports", label: "报告中心", description: "综述与导出" },
  { id: "reproduction", label: "文献复现", description: "数据集与代码骨架" },
];
