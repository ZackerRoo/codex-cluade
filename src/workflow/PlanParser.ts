export interface PlanStep {
  text: string;
  completed: boolean;
  line: number;
}

export interface PlanSummary {
  totalSteps: number;
  completedSteps: number;
  progressPercent: number;
  steps: PlanStep[];
}

export function parsePlanChecklist(content: string): PlanSummary {
  const steps: PlanStep[] = [];
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    steps.push({
      text: match[2],
      completed: match[1].toLowerCase() === "x",
      line: index + 1
    });
  }
  const completedSteps = steps.filter(step => step.completed).length;
  return {
    totalSteps: steps.length,
    completedSteps,
    progressPercent: steps.length === 0 ? 0 : Math.round((completedSteps / steps.length) * 100),
    steps
  };
}
